import { SuriError, type Data } from "../../../packages/protocol/src/index.js";
import { displayText } from "../../../packages/pi-adapter/src/index.js";
import type { Assets } from "./assets.js";
import type { HostQueue } from "./host-queue.js";
import type { Interactions } from "./host-interactions.js";
import type { Stream } from "./host-stream.js";

/**
 * Sole owner of transcript write batching and artifact serialization
 * (pendingMessageWrites / imageWrites) plus the session event emit path.
 */
export function createMessageWrites(caps: {
  assets: Assets;
  closing: () => boolean;
  hostRuntime: {
    touch: (sessionId: string) => void;
    client: (
      sessionId: string,
    ) => { respond: (id: string, answer: Data) => unknown } | undefined;
  };
  hostQueue: Pick<HostQueue, "shadows">;
  publish: Stream["publish"];
  interactions: Interactions;
}) {
  const { assets, hostRuntime, hostQueue, publish, interactions } = caps;
  // `owned` marks writes admitted before close (buffered messages, artifact
  // jobs and their continuations); only those may persist during the drain.
  const emitImmediate = (
    sessionId: string,
    type: string,
    p: Data,
    owned = false,
  ) => {
    if (caps.closing() && !owned) return;
    if (type === "queue.state") {
      const available = [...(hostQueue.shadows(sessionId) ?? [])];
      p = {
        ...p,
        items: (p.items ?? []).map((item: Data) => {
          const index = available.findIndex(
            (shadow) =>
              shadow.wireText === item.text && shadow.mode === item.mode,
          );
          if (index < 0) return item;
          const shadow = available.splice(index, 1)[0];
          return {
            mode: item.mode,
            text: shadow.text,
            attachmentIds: shadow.attachmentIds,
            queueId: shadow.queueId,
            clientId: shadow.clientId,
          };
        }),
      };
    }
    if (type === "extension.request") {
      const method = p.method;
      if (["select", "confirm", "input", "editor"].includes(method)) {
        interactions.request(sessionId, p, method);
      } else if (
        [
          "notify",
          "setStatus",
          "setWidget",
          "setTitle",
          "set_editor_text",
        ].includes(method)
      ) {
        publish(
          `session:${sessionId}`,
          method === "setWidget"
            ? "extension.widget"
            : method === "set_editor_text"
              ? "extension.editor"
              : "extension.status",
          {
            key: String(p.widgetKey ?? p.statusKey ?? method),
            text: displayText(
              p.message ?? p.statusText ?? p.title ?? p.text ?? "",
            ),
            lines: Array.isArray(p.widgetLines)
              ? p.widgetLines
                  .filter((x: unknown) => typeof x === "string")
                  .map(displayText)
              : [],
            placement: p.widgetPlacement,
          },
        );
      } else if (p.id) {
        hostRuntime.client(sessionId)?.respond(p.id, { cancelled: true });
        publish(`session:${sessionId}`, "notice", {
          code: "EXTENSION_UI",
          text: String(p.message ?? p.text ?? "Extension notification").slice(
            0,
            10000,
          ),
        });
      }
      return;
    }
    const event = publish(`session:${sessionId}`, type, p);
    if (type === "message.upsert" && p.role === "assistant" && p.final)
      publish("catalog", "catalog.sessionActivity", {
        sessionId,
        seq: event.seq,
      });
  };
  let fallbackFailed = false;
  /**
   * Publishes artifact.ready. The event is committed once store.event succeeds
   * (the stream head advances); a later socket fanout error keeps the asset.
   */
  const publishReady = (sessionId: string, asset: Data) => {
    const before = assets.head(sessionId);
    try {
      emitImmediate(sessionId, "artifact.ready", asset, true);
    } catch (error) {
      if (assets.head(sessionId) !== before) return;
      assets.discard(asset);
      throw error;
    }
  };
  const imageWrites = new Map<string, Promise<unknown>>();
  const chained = new Set<Promise<unknown>>();
  const pendingMessageWrites = new Map<
    string,
    { payload: Data; timer: NodeJS.Timeout }
  >();
  const flushPendingMessage = (sessionId: string) => {
    const pending = pendingMessageWrites.get(sessionId);
    if (!pending) return;
    clearTimeout(pending.timer);
    pendingMessageWrites.delete(sessionId);
    emitImmediate(sessionId, "message.upsert", pending.payload, true);
  };
  const emit = (sessionId: string, type: string, p: Data) => {
    hostRuntime.touch(sessionId);
    // Admission is captured at entry: nothing new is accepted once closing.
    if (caps.closing()) return;
    // Pi can emit a complete growing assistant message for every token. Persisting
    // and rendering every intermediate copy makes one busy session stall the
    // shared host and every client. Keep final and cross-event ordering exact,
    // while limiting intermediate transcript work to twenty updates per second.
    if (type === "message.upsert" && p.role === "assistant" && !p.final) {
      const previous = pendingMessageWrites.get(sessionId);
      if (previous) {
        previous.payload = p;
      } else {
        pendingMessageWrites.set(sessionId, {
          payload: p,
          timer: setTimeout(() => flushPendingMessage(sessionId), 50),
        });
      }
      return;
    }
    flushPendingMessage(sessionId);
    const pending = imageWrites.get(sessionId);
    if (type === "artifact.inline") {
      const job = (pending ?? Promise.resolve())
        .then(async () => {
          if (typeof p.data !== "string" || p.data.length > 14 * 1048576)
            throw new SuriError(
              "LIMIT_EXCEEDED",
              "Image output exceeded the artifact limit.",
            );
          const asset = await assets.upload(
            Buffer.from(p.data, "base64"),
            "Pi image",
            p.mime,
            "attachment",
            sessionId,
            p.id,
          );
          publishReady(sessionId, asset);
        })
        .catch(() =>
          emitImmediate(
            sessionId,
            "notice",
            {
              code: "ARTIFACT_UNAVAILABLE",
              text: "An image output could not be decoded or exceeded its limit.",
            },
            true,
          ),
        );
      imageWrites.set(sessionId, job);
      void job.finally(() => {
        if (imageWrites.get(sessionId) === job) imageWrites.delete(sessionId);
      });
      return;
    }
    const serialized = JSON.stringify(p);
    if (Buffer.byteLength(serialized) > 384 * 1024) {
      const job = (pending ?? Promise.resolve())
        .then(async () => {
          const artifact = await assets.output(serialized, sessionId);
          const preview: Data = {
            ...p,
            blocks: [
              {
                kind: "text",
                id: `${artifact.id}:preview`,
                text: "Large output is stored separately to keep the conversation responsive.",
                artifactId: artifact.id,
              },
            ],
          };
          delete preview.text;
          delete preview.arguments;
          publishReady(sessionId, artifact);
          emitImmediate(
            sessionId,
            type === "message.delta" ? "notice" : type,
            type === "message.delta"
              ? {
                  code: "LARGE_OUTPUT",
                  text: "Large streamed output will be available in the final artifact.",
                }
              : preview,
            true,
          );
        })
        .catch(() => {
          // Keep the full original first; never claim it was saved if it was not.
          try {
            emitImmediate(sessionId, type, p, true);
          } catch {
            fallbackFailed = true;
            return;
          }
          try {
            emitImmediate(
              sessionId,
              "notice",
              {
                code: "ARTIFACT_UNAVAILABLE",
                text: "Attachment not saved; the original message is retained.",
              },
              true,
            );
          } catch {
            fallbackFailed = true;
          }
        });
      imageWrites.set(sessionId, job);
      void job.finally(() => {
        if (imageWrites.get(sessionId) === job) imageWrites.delete(sessionId);
      });
      return;
    }
    if (pending) {
      // Owned continuation: the shutdown drain awaits it like an artifact job.
      const next = pending.then(() => emitImmediate(sessionId, type, p, true));
      chained.add(next);
      void next.finally(() => chained.delete(next));
    } else emitImmediate(sessionId, type, p);
  };
  return {
    emit,
    hasImageWrite: (id: string) => imageWrites.has(id),
    imageWriteSessions: () => [...imageWrites.keys()],
    imageWriteCount: () => imageWrites.size,
    /**
     * Shutdown: returns the next batch of owned artifact writes to await, or
     * undefined once none remain, so an empty drain adds no microtask. Throws
     * when a fallback original was lost.
     */
    nextDrain() {
      if (imageWrites.size || chained.size)
        return Promise.allSettled([...imageWrites.values(), ...chained]);
      if (fallbackFailed)
        throw new SuriError(
          "ARTIFACT_FALLBACK_PERSIST_FAILED",
          "An original message could not be persisted after its attachment failed.",
        );
    },
    pendingMessageCount: () => pendingMessageWrites.size,
    /** Shutdown: flushes every pending intermediate transcript write. */
    flushAll() {
      for (const id of [...pendingMessageWrites.keys()])
        flushPendingMessage(id);
    },
  };
}
export type MessageWrites = ReturnType<typeof createMessageWrites>;
