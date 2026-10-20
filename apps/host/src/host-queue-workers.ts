import { randomUUID } from "node:crypto";
import { realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ReviewQueueRuntime,
  ReviewQueueRuntimeError,
  ReviewQueueWorkerProfile,
  ReviewQueueHost,
  type QueueHostLaunch,
} from "../../../packages/pi-adapter/src/review-queue.js";
import {
  SuriError,
  type Command,
  type Data,
  type Receipt,
} from "../../../packages/protocol/src/index.js";
import type { HostRuntime } from "./host-runtime.js";
import type { Storage } from "./storage.js";

export type QueueBootPermit = QueueHostLaunch & { active: boolean };
export type ExecuteUnlocked = (
  c: Command,
  clientId: string,
  internal?: {
    reservedSessionId?: string;
    rejectExistingSession?: boolean;
    queueWorker?: Data;
    queueBootPermit?: QueueBootPermit;
  },
) => Promise<Receipt>;

/** Owner of the review-queue host binding, boot permits and worker retirement. */
export function createQueueWorkers(caps: {
  store: Storage;
  options: {
    root: string;
    helper: string;
    reviewQueueExtension?: string;
    reviewQueueBootTimeoutMs?: number;
  };
  executeUnlocked: ExecuteUnlocked;
  hostRuntime: Pick<HostRuntime, "hasClient" | "isBooting" | "client" | "boot">;
}) {
  const { store, options, executeUnlocked, hostRuntime } = caps;
  const queueRuntime = new ReviewQueueRuntime(
    join(options.root, "review-queue", "snapshots"),
    options.helper,
    options.root,
  );
  const queueProfile = new ReviewQueueWorkerProfile(
    queueRuntime,
    options.reviewQueueExtension ??
      fileURLToPath(
        new URL(
          "../../../packages/pi-adapter/src/review-queue-extension.js",
          import.meta.url,
        ),
      ),
  );
  const reviewQueueHost = new ReviewQueueHost(
    queueRuntime,
    queueProfile,
    join(options.root, "review-queue", "results"),
    async (launch) => {
      const permit: QueueBootPermit = { ...launch, active: true };
      const { targetSessionId, role, source } = permit;
      let created: Receipt | undefined;
      try {
        const workspace = store.get("workspace", source.workspaceId);
        const sourceSession = store.get("session", source.sourceHostSessionId);
        const runtime = store.get("runtime", source.runtimeId);
        if (
          sourceSession.workspaceId !== source.workspaceId ||
          sourceSession.runtimeId !== source.runtimeId ||
          runtime.id !== source.runtimeId ||
          // An unresolvable root becomes "" and fails the repository match below.
          (await realpath(workspace.root).catch(() => "")) !== source.repository
        )
          throw new ReviewQueueRuntimeError(
            "source_authority_mismatch",
            "The exact authenticated queue workspace is unavailable.",
          );
        created = await executeUnlocked(
          {
            v: 1,
            id: randomUUID(),
            createdAt: new Date().toISOString(),
            type: "session.create",
            payload: {
              workspaceId: source.workspaceId,
              runtimeId: source.runtimeId,
              name: `Review queue · ${role}`,
            },
          },
          "review-queue:host",
          {
            reservedSessionId: targetSessionId,
            rejectExistingSession: true,
            queueWorker: {
              schema: 1,
              role,
              runtimeSessionId: permit.runtimeSessionId,
              epoch: permit.epoch,
              launchKey: permit.launchKey,
              profileArgs: permit.profileArgs,
              authority: source,
              state: "reserved",
            },
          },
        );
        if (
          created.status !== "completed" ||
          created.result?.id !== targetSessionId
        )
          throw new ReviewQueueRuntimeError(
            "worker_create_failed",
            "Queue host session creation did not complete exactly.",
          );
        const resumeCommand: Command = {
          v: 1,
          id: randomUUID(),
          createdAt: new Date().toISOString(),
          type: "session.resume",
          sessionId: targetSessionId,
          payload: {},
        };
        let resumed = await executeUnlocked(
          resumeCommand,
          "review-queue:host",
          { queueBootPermit: permit },
        );
        if (resumed.status !== "accepted" && resumed.status !== "completed")
          throw new ReviewQueueRuntimeError(
            "worker_boot_failed",
            "Queue host session resume was rejected.",
          );
        const deadline =
          Date.now() + (options.reviewQueueBootTimeoutMs ?? 20_000);
        while (resumed.status === "accepted" && Date.now() < deadline) {
          await new Promise((done) => setTimeout(done, 10));
          resumed = store.commandReceipt(resumeCommand.id) ?? resumed;
        }
        if (resumed.status !== "completed")
          throw new ReviewQueueRuntimeError(
            resumed.status === "accepted"
              ? "worker_boot_timeout"
              : "worker_boot_failed",
            "Queue worker boot did not reach a durable completed receipt.",
          );
        assertQueueBootPermit(targetSessionId, permit);
        const session = store.get("session", targetSessionId);
        store.put("session", {
          ...session,
          queueWorker: { ...session.queueWorker, state: "active" },
        });
        return { created, resumed };
      } catch (error) {
        permit.active = false;
        if (created?.status === "completed")
          await retireQueueSession(targetSessionId, permit);
        throw error;
      }
    },
    (targetSessionId) => ({
      exists: store
        .list("session")
        .some((session) => session.id === targetSessionId),
      active:
        hostRuntime.hasClient(targetSessionId) ||
        hostRuntime.isBooting(targetSessionId),
    }),
  );
  function assertQueueBootPermit(id: string, permit?: QueueBootPermit) {
    const session = store.get("session", id);
    const durable = session.queueWorker;
    if (!durable) {
      if (permit)
        throw new SuriError(
          "RUNTIME_UNSUPPORTED",
          "Queue boot authority does not match an owned reserved session.",
        );
      return;
    }
    const binding = reviewQueueHost.binding(id);
    const expectedArgs = reviewQueueHost.args(id);
    if (
      !permit?.active ||
      !binding ||
      binding.role !== permit.role ||
      binding.sessionId !== permit.runtimeSessionId ||
      binding.epoch !== permit.epoch ||
      durable.schema !== 1 ||
      durable.role !== permit.role ||
      durable.runtimeSessionId !== permit.runtimeSessionId ||
      durable.epoch !== permit.epoch ||
      durable.launchKey !== permit.launchKey ||
      JSON.stringify(durable.profileArgs) !==
        JSON.stringify(permit.profileArgs) ||
      JSON.stringify(expectedArgs) !== JSON.stringify(permit.profileArgs) ||
      JSON.stringify(durable.authority) !== JSON.stringify(permit.source) ||
      durable.state !== "reserved"
    )
      throw new SuriError(
        "RUNTIME_UNSUPPORTED",
        "Persistent queue sessions require their exact live fenced authority.",
      );
  }
  function markQueueSessionState(id: string, state: string) {
    try {
      const session = store.get("session", id);
      if (!session.queueWorker) return;
      store.put("session", {
        ...session,
        processPid: undefined,
        queueWorker: { ...session.queueWorker, state },
      });
    } catch {
      // Best effort: the session record may already be gone; retirement proceeds either way.
    }
  }
  async function retireQueueSession(id: string, permit: QueueBootPermit) {
    permit.active = false;
    markQueueSessionState(id, "retiring");
    const child = hostRuntime.client(id);
    child?.forceStop();
    // Best effort: a failed boot or exit is irrelevant once the worker is force-stopped;
    // retirement continues and removes the record below.
    await hostRuntime.boot(id)?.catch(() => undefined);
    await child?.exited.catch(() => undefined);
    try {
      const session = store.get("session", id);
      if (
        session.queueWorker?.launchKey === permit.launchKey &&
        session.queueWorker?.runtimeSessionId === permit.runtimeSessionId
      ) {
        store.remove("session", id);
        await rm(join(options.root, "runtime", id), {
          recursive: true,
          force: true,
        });
      }
    } catch {
      // Best effort: the record or runtime directory may already be gone; the session is retired either way.
    }
  }
  return {
    reviewQueueHost,
    assertQueueBootPermit,
    markQueueSessionState,
  };
}
