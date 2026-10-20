import type { Data } from "../../../packages/protocol/src/index.js";
import type { Storage } from "./storage.js";

/** Sole owner of the per-session queue shadows and queue restoration. */
export function createQueue(caps: {
  store: Storage;
  emit: (sessionId: string, type: string, p: Data) => void;
}) {
  const { store, emit } = caps;
  const queueShadows = new Map<string, Data[]>();
  function restoreQueue(sessionId: string, clientId: string, queue: Data[]) {
    const text = queue
      .map((q) => q.text)
      .filter(Boolean)
      .join("\n\n");
    const attachmentIds = [
      ...new Set(queue.flatMap((q) => q.attachmentIds ?? [])),
    ];
    if (!text && !attachmentIds.length) return {};
    let old: Data = { text: "", attachmentIds: [], revision: 0 };
    try {
      old = store.get("draft", `${sessionId}:${clientId}`);
    } catch {
      // No previous draft: start from the empty default above.
    }
    store.put("draft", {
      id: `${sessionId}:${clientId}`,
      sessionId,
      clientId,
      text: [old.text, text].filter(Boolean).join("\n\n"),
      attachmentIds: [...new Set([...old.attachmentIds, ...attachmentIds])],
      revision: old.revision + 1,
      updatedAt: new Date().toISOString(),
    });
    const attachments = attachmentIds.map((id) => {
      const asset = store.get("asset", id);
      return { id, name: asset.name, mime: asset.mime };
    });
    emit(sessionId, "draft.restored", {
      clientId,
      text,
      attachments,
      revision: old.revision + 1,
    });
    emit(sessionId, "notice", {
      code: "RESTORED_QUEUE",
      text: "Cleared queued messages were returned to your draft.",
    });
    return { restoredDraft: text, attachmentIds };
  }
  return {
    restoreQueue,
    shadows(sessionId: string) {
      return queueShadows.get(sessionId);
    },
    setShadows(sessionId: string, items: Data[]) {
      queueShadows.set(sessionId, items);
    },
  };
}
export type HostQueue = ReturnType<typeof createQueue>;
