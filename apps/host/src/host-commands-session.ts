import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  SuriError,
  requiredString,
  type Command,
  type Data,
} from "../../../packages/protocol/src/index.js";
import type { HostRuntime } from "./host-runtime.js";
import type { MessageWrites } from "./host-message-writes.js";
import type { Stream } from "./host-stream.js";
import type { Storage } from "./storage.js";

/**
 * Synchronous session command bodies. Awaited cases (resume, branch/clone,
 * runtime switch) keep their await frame in the dispatcher and call these only
 * for the synchronous parts.
 */
export function createSessionCommands(caps: {
  store: Storage;
  hostRuntime: Pick<HostRuntime, "client" | "dropClient">;
  publish: Stream["publish"];
  emit: MessageWrites["emit"];
  idle: (sessionId: string) => void;
}) {
  const { store, hostRuntime, publish, emit, idle } = caps;
  return {
    /** Everything after the awaited workspace availability check. */
    sessionCreate(
      p: Data,
      workspace: Data,
      internal?: {
        reservedSessionId?: string;
        rejectExistingSession?: boolean;
        queueWorker?: Data;
      },
    ): Data {
      let result: Data = {};
      const project = store.get("project", workspace.projectId);
      const projectWorkspaceIds = new Set(
        store
          .list("workspace")
          .filter((candidate) => candidate.projectId === project.id)
          .map((candidate) => candidate.id),
      );
      const recentProjectSessions = store
        .list("session")
        .filter(
          (candidate) =>
            candidate.runtimeId === p.runtimeId &&
            projectWorkspaceIds.has(candidate.workspaceId),
        )
        .sort((a, b) =>
          String(b.updatedAt ?? b.createdAt ?? "").localeCompare(
            String(a.updatedAt ?? a.createdAt ?? ""),
          ),
        );
      const inheritedModel =
        project.lastModelByRuntime?.[p.runtimeId] ??
        recentProjectSessions.find((candidate) => candidate.model)?.model;
      const inheritedThinking =
        project.lastThinkingByRuntime?.[p.runtimeId] ??
        recentProjectSessions.find((candidate) => candidate.thinkingLevel)
          ?.thinkingLevel;
      const targetSessionId = internal?.reservedSessionId ?? randomUUID();
      if (
        internal?.rejectExistingSession &&
        store
          .list("session")
          .some((candidate) => candidate.id === targetSessionId)
      )
        throw new SuriError(
          "CONFLICT",
          "The reserved queue session already exists.",
        );
      const session = store.put("session", {
        id: targetSessionId,
        workspaceId: workspace.id,
        runtimeId: p.runtimeId,
        name: p.name ?? "New session",
        nameSource: p.name ? "manual" : "default",
        archived: false,
        revision: 1,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        ...(inheritedModel ? { model: inheritedModel } : {}),
        ...(inheritedThinking ? { thinkingLevel: inheritedThinking } : {}),
        ...(internal?.queueWorker ? { queueWorker: internal.queueWorker } : {}),
      });
      publish("catalog", "catalog.session", session);
      result = session;
      return result;
    },
    sessionReorder(p: Data): Data {
      let result: Data = {};
      const ids = p.sessionIds;
      if (
        !Array.isArray(ids) ||
        !ids.length ||
        ids.length > 10000 ||
        ids.some((value) => typeof value !== "string") ||
        new Set(ids).size !== ids.length
      )
        throw new SuriError("VALIDATION", "Provide distinct session ids.");
      const items = ids.map((value) => store.get("session", value));
      const first = items[0];
      if (
        items.some(
          (item) =>
            item.workspaceId !== first.workspaceId ||
            !!item.pinned !== !!first.pinned ||
            !!item.archived !== !!first.archived,
        )
      )
        throw new SuriError(
          "VALIDATION",
          "Reorder sessions within the same workspace and group.",
        );
      result = store.db.transaction(() =>
        items.map((item, order) => {
          const expected = p.revisions?.[item.id];
          if (!Number.isInteger(expected))
            throw new SuriError(
              "VALIDATION",
              "Session revisions are required.",
            );
          return store.patch("session", item.id, expected, { order });
        }),
      )();
      publish("catalog", "catalog.sessionsReordered", { sessionIds: ids });
      return result;
    },
    sessionPatch(c: Command, p: Data, id: string | undefined): Data {
      let result: Data = {};
      if (!id) throw new SuriError("VALIDATION", "Select a session.");
      if (c.type === "session.archive") idle(id);
      const patch =
        c.type === "session.rename"
          ? { name: requiredString(p, "name", 200), nameSource: "manual" }
          : c.type === "session.archive"
            ? { archived: !!p.archived }
            : c.type === "session.pin"
              ? { pinned: !!p.pinned }
              : { highlighted: !!p.highlighted };
      result = store.patch("session", id, c.expectedRevision, patch);
      publish("catalog", "catalog.session", result);
      return result;
    },
    sessionClose(id: string | undefined): Data {
      const result: Data = {};
      if (!id) throw new SuriError("VALIDATION", "Select a session.");
      idle(id);
      hostRuntime.client(id)?.close();
      hostRuntime.dropClient(id);
      emit(id, "session.state", { phase: "closed" });
      return result;
    },
    sessionHistory(p: Data, id: string | undefined): Data {
      let result: Data = {};
      if (!id) throw new SuriError("VALIDATION", "Select a session.");
      result = store.history(`session:${id}`, p.before, p.limit);
      return result;
    },
    sessionRead(p: Data, id: string | undefined): Data {
      let result: Data = {};
      if (!id) throw new SuriError("VALIDATION", "Select a session.");
      const old = store.get("session", id);
      result = store.put("session", {
        ...old,
        lastReadSeq: Math.max(
          old.lastReadSeq ?? 0,
          Math.min(p.throughSeq ?? 0, store.snapshot(`session:${id}`).seq),
        ),
      });
      publish("catalog", "catalog.session", result);
      return result;
    },
    sessionMarkUnread(id: string | undefined): Data {
      let result: Data = {};
      if (!id) throw new SuriError("VALIDATION", "Select a session.");
      const old = store.get("session", id);
      const seq = store.snapshot(`session:${id}`).seq;
      result = store.put("session", {
        ...old,
        lastReadSeq: Math.max(0, seq - 1),
      });
      publish("catalog", "catalog.session", result);
      return result;
    },
    /** Synchronous prelude of branch/clone; returns the parent session. */
    sessionForkPrelude(c: Command, id: string): Data {
      idle(id);
      const parent = store.get("session", id);
      if (parent.revision !== c.expectedRevision)
        throw new SuriError("CONFLICT", "Session changed.");
      return parent;
    },
    sessionCreateTarget(p: Data) {
      const workspace = store.get(
        "workspace",
        requiredString(p, "workspaceId"),
      );
      store.get("runtime", requiredString(p, "runtimeId"));
      return workspace;
    },
    workspaceUnavailable() {
      return new SuriError(
        "NOT_FOUND",
        "This workspace is not available on this computer. Add its checkout on this computer first.",
      );
    },
    exportOptions(current: Data) {
      return {
        name: `${String(current.name ?? "Pi session").replace(/[\\/:*?"<>|]/g, "_")}.html`,
        mime: "text/html",
      };
    },
    runtimeSwitchFile(root: string, id: string) {
      return join(root, "runtime", id, `switch-${randomUUID()}.jsonl`);
    },
    /** Synchronous prelude of the runtime switch, before the awaited child close. */
    sessionRuntimePrelude(
      c: Command,
      p: Data,
      id: string,
    ): { old: Data; runtime: Data } {
      idle(id);
      const old = store.get("session", id);
      if (old.revision !== c.expectedRevision)
        throw new SuriError("CONFLICT", "Session changed.");
      const runtime = store.get("runtime", requiredString(p, "runtimeId"));
      if (runtime.status !== "verified")
        throw new SuriError("RUNTIME_UNSUPPORTED", "Runtime is not verified.");
      return { old, runtime };
    },
    sessionRuntimePut(old: Data, runtime: Data, piFile: unknown) {
      store.put("session", {
        ...old,
        runtimeId: runtime.id,
        piFile,
        revision: old.revision + 1,
      });
    },
  };
}
