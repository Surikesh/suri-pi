import { randomUUID } from "node:crypto";
import {
  SuriError,
  type Command,
  type Data,
} from "../../../packages/protocol/src/index.js";
import type { HostRuntime } from "./host-runtime.js";
import type { QueueBootPermit } from "./host-queue-workers.js";
import type { Stream } from "./host-stream.js";
import type {
  RuntimeValidationProfile,
  RuntimeValidator,
} from "./runtime-validation.js";
import type { Storage } from "./storage.js";
import type { StartSession } from "./host-types.js";

/**
 * Inert factories for the session async job callbacks. Each method only
 * allocates and returns the async callback; `AsyncJobOwner.submit` schedules
 * and runs it. Nothing here reads state before the job runs, and no factory
 * adds a promise, await or wrapper.
 */
export function createSessionJobs(caps: {
  store: Storage;
  hostRuntime: Pick<HostRuntime, "client" | "dropClient">;
  publish: Stream["publish"];
  runtimeValidator: Pick<RuntimeValidator, "validateAndPromote">;
  startSession: StartSession;
}) {
  const { store, hostRuntime, publish, runtimeValidator, startSession } = caps;
  return {
    runtimeValidate(runtimeId: string, profile: RuntimeValidationProfile) {
      return async () => {
        const promoted = await runtimeValidator.validateAndPromote(
          store,
          runtimeId,
          profile,
        );
        publish("catalog", "runtime.compatibility", promoted);
        return {
          runtimeId: promoted.id,
          status: promoted.status,
          identity: promoted.identity,
          evidenceId: promoted.evidenceId,
          validatedAt: promoted.validatedAt,
        };
      };
    },
    sessionResume(
      id: string,
      internal?: { queueBootPermit?: QueueBootPermit },
    ) {
      return async () => {
        await startSession(id, internal?.queueBootPermit, "explicit-resume");
        return {};
      };
    },
    sessionReload(id: string) {
      return async () => {
        const previous = hostRuntime.client(id);
        if (previous) {
          previous.close();
          if (previous.child.exitCode === null)
            await new Promise<void>((resolve) =>
              previous.child.once("exit", () => resolve()),
            );
          if (hostRuntime.client(id) === previous) hostRuntime.dropClient(id);
        }
        await startSession(id);
        return { reloaded: true };
      };
    },
    sessionFork(c: Command, p: Data, id: string, parent: Data) {
      return async () => {
        const pi = await startSession(id);
        if (c.type === "session.branch") {
          const eligible = await pi.request("get_fork_messages");
          if (
            !(eligible.messages ?? []).some(
              (m: Data) => m.entryId === p.entryId,
            )
          )
            throw new SuriError(
              "VALIDATION",
              "Choose an eligible user message.",
            );
        }
        const fork = await pi.request(
          c.type === "session.clone" ? "clone" : "fork",
          c.type === "session.branch" ? { entryId: p.entryId } : {},
        );
        if (fork.cancelled) return { cancelled: true };
        const state = await pi.request("get_state");
        const nextId = randomUUID();
        const next = {
          ...parent,
          id: nextId,
          parentId: id,
          processPid: undefined,
          name: parent.name + " · branch",
          revision: 1,
          piSessionId: state.sessionId,
          piFile: state.sessionFile,
        };
        store.put("session", next);
        hostRuntime.dropClient(id);
        pi.close();
        publish("catalog", "catalog.session", next);
        return { ...next, draft: fork.text ?? "" };
      };
    },
  };
}
