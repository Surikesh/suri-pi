import { activePhases } from "../../../packages/protocol/src/index.js";
import type { AsyncJobOwner } from "./async-jobs.js";
import type { HostRuntime } from "./host-runtime.js";
import type { Interactions } from "./host-interactions.js";
import type { MessageWrites } from "./host-message-writes.js";
import type { ModernUpdates } from "./modern-updates.js";
import type { Resources } from "./resources.js";
import type { Storage } from "./storage.js";

/**
 * Residual protected-work projection. It composes bounded counts and
 * per-session categories from narrow owner operations only.
 */
export function createWork(caps: {
  store: Storage;
  hostRuntime: Pick<
    HostRuntime,
    "workSessions" | "isBooting" | "isRetiring" | "client" | "hasSubmission"
  >;
  messageWrites: Pick<
    MessageWrites,
    | "imageWriteSessions"
    | "hasImageWrite"
    | "imageWriteCount"
    | "pendingMessageCount"
  >;
  interactions: Pick<Interactions, "sessionIds" | "hasSession">;
  resources: Pick<Resources, "activeTerminalCount">;
  modernUpdates: () => Pick<ModernUpdates, "busy"> | undefined;
  jobs: Pick<AsyncJobOwner, "pendingCount" | "unresolvedCount">;
  pendingCommands: () => number;
  pendingIngress: () => number;
  pendingUpdateControls: () => number;
}) {
  const { store, hostRuntime, messageWrites, interactions, resources } = caps;
  const protectedWork = () => {
    const workSessions = new Set([
      ...hostRuntime.workSessions(),
      ...messageWrites.imageWriteSessions(),
      ...interactions.sessionIds(),
    ]);
    const matchingSessionOwners = [...workSessions]
      .map((id) => {
        const snapshot = store.snapshot(`session:${id}`);
        const categories = [
          ...(hostRuntime.isBooting(id) ? ["boot"] : []),
          ...(hostRuntime.isRetiring(id) ? ["retirement"] : []),
          ...(hostRuntime.client(id)?.hasPendingRequests ? ["rpc"] : []),
          ...(activePhases.has(snapshot.phase) ? ["turn"] : []),
          ...(snapshot.queue.length > 0 ? ["queue"] : []),
          ...(hostRuntime.hasSubmission(id) ? ["submission"] : []),
          ...(messageWrites.hasImageWrite(id) ? ["image-write"] : []),
          ...(interactions.hasSession(id) ? ["interaction"] : []),
        ];
        return categories.length
          ? {
              owner: id,
              ...(hostRuntime.client(id)?.startupAttemptId
                ? { attempt: hostRuntime.client(id)!.startupAttemptId }
                : {}),
              categories,
            }
          : undefined;
      })
      .filter(Boolean);
    const activeSessions = matchingSessionOwners.length;
    const sessionOwners = matchingSessionOwners.slice(0, 50);
    const blockers = [
      {
        kind: "sessions-or-rpc",
        count: activeSessions,
        owners: sessionOwners,
        truncated: activeSessions > sessionOwners.length,
      },
      { kind: "accepted-jobs", count: caps.jobs.pendingCount },
      { kind: "completion-persistence", count: caps.jobs.unresolvedCount },
      { kind: "commands", count: caps.pendingCommands() },
      { kind: "ingress", count: caps.pendingIngress() },
      { kind: "update-control", count: caps.pendingUpdateControls() },
      { kind: "artifact-import", count: caps.modernUpdates()?.busy ?? 0 },
      { kind: "image-writes", count: messageWrites.imageWriteCount() },
      { kind: "transcript-writes", count: messageWrites.pendingMessageCount() },
      { kind: "terminals", count: resources.activeTerminalCount },
    ].filter((blocker) => blocker.count > 0);
    return {
      count: blockers.reduce((sum, blocker) => sum + blocker.count, 0),
      blockers,
    };
  };
  const activeWork = () => protectedWork().count;
  return {
    protectedWork,
    activeWork,
    unresolvedCompletions: () => caps.jobs.unresolvedCount,
  };
}
