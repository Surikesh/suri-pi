import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  PiClient,
  probe,
  content,
  type RuntimeStartupTrigger,
} from "../../../packages/pi-adapter/src/index.js";
import type { ReviewQueueHost } from "../../../packages/pi-adapter/src/review-queue.js";
import { SuriError, type Data } from "../../../packages/protocol/src/index.js";
import type { QueueBootPermit } from "./host-queue-workers.js";
import type { SessionBroker } from "./host-session-broker.js";
import type { HostRuntime } from "./host-runtime.js";
import type { Storage } from "./storage.js";

/** Owner of the single boot lifecycle: probe, spawn, fence, cleanup. */
export function createSessionStart(caps: {
  store: Storage;
  options: { root: string; simulated?: boolean; validation?: boolean };
  emit: (sessionId: string, type: string, p: Data) => void;
  publish: (stream: string, type: string, p: Data) => unknown;
  closing: () => boolean;
  hostRuntime: Pick<
    HostRuntime,
    | "isRetiring"
    | "markRetiring"
    | "clearRetiring"
    | "touch"
    | "forgetUse"
    | "client"
    | "setClient"
    | "dropClient"
    | "boot"
    | "setBoot"
    | "clearBoot"
  >;
  reviewQueueHost: ReviewQueueHost;
  assertQueueBootPermit: (id: string, permit?: QueueBootPermit) => void;
  markQueueSessionState: (id: string, state: string) => void;
  sessionBroker: SessionBroker;
}) {
  const {
    store,
    options,
    emit,
    publish,
    hostRuntime,
    reviewQueueHost,
    assertQueueBootPermit,
    markQueueSessionState,
    sessionBroker,
  } = caps;
  async function startSession(
    id: string,
    queuePermit?: QueueBootPermit,
    trigger: RuntimeStartupTrigger = "other",
  ): Promise<PiClient> {
    assertQueueBootPermit(id, queuePermit);
    if (hostRuntime.isRetiring(id)) {
      const child = hostRuntime.client(id)?.child;
      if (child && child.exitCode === null && child.signalCode === null)
        await new Promise<void>((resolve, reject) => {
          const done = () => {
            clearTimeout(timer);
            resolve();
          };
          const timer = setTimeout(() => {
            child.off("exit", done);
            reject(
              new SuriError(
                "BUSY",
                "Idle runtime shutdown has not completed after 5 seconds. Your draft is retained.",
              ),
            );
          }, 5000);
          child.once("exit", done);
        });
    }
    hostRuntime.touch(id);
    // Join an in-flight boot before reusing its not-yet-ready child.
    const boot = hostRuntime.boot(id);
    if (boot) return boot;
    const existing = hostRuntime.client(id);
    if (existing) return existing;
    const promise = (async () => {
      const session = store.get("session", id);
      assertQueueBootPermit(id, queuePermit);
      if (session.processPid) {
        let exists = false;
        try {
          process.kill(session.processPid, 0);
          exists = true;
        } catch {
          // Signal 0 throws when the recorded pid is not alive; exists stays false.
        }
        if (exists)
          throw new SuriError(
            "CONFLICT",
            "A prior runtime process may still own this session. Resolve its ownership before resuming.",
          );
      }
      const workspace = store.get("workspace", session.workspaceId);
      const runtime = store.get("runtime", session.runtimeId);
      const checked = options.simulated
        ? { identity: runtime.identity }
        : await probe(runtime.executable, runtime.version);
      if (checked.identity !== runtime.identity)
        throw new SuriError(
          "RUNTIME_UNSUPPORTED",
          "The runtime artifact changed; validation is required.",
        );
      if (runtime.status !== "verified" && !options.validation)
        throw new SuriError(
          "RUNTIME_UNSUPPORTED",
          "This runtime candidate requires real smoke validation.",
        );
      const sessionDir = join(options.root, "runtime", id);
      await mkdir(sessionDir, { recursive: true, mode: 0o700 });
      emit(id, "session.state", { phase: "starting" });
      const { queueWorkerBinding, privateControl } = sessionBroker.open(
        id,
        workspace,
        runtime,
      );
      assertQueueBootPermit(id, queuePermit);
      const client = new PiClient(
        {
          executable: runtime.executable,
          cwd: workspace.root,
          sessionDir,
          sessionFile: session.piFile,
          extraArgs: options.validation
            ? ["--no-extensions", "--no-skills", "--no-prompt-templates"]
            : queueWorkerBinding
              ? queuePermit!.profileArgs
              : [],
          privateControl,
          startup: {
            trigger,
            diagnostic: (diagnostic) =>
              emit(id, "notice", {
                code: "runtime_startup_failed",
                severity: "error",
                text: `Pi startup failed (${diagnostic.category}, ${diagnostic.stage}; attempt ${diagnostic.attemptId}).`,
                diagnostic,
              }),
          },
        },
        (t, p) => emit(id, t, p),
      );
      hostRuntime.setClient(id, client);
      store.put("session", {
        ...store.get("session", id),
        processPid: client.child.pid,
      });
      let ownerCleaned = false;
      const cleanupOwner = () => {
        if (ownerCleaned) return;
        ownerCleaned = true;
        const queueBinding = reviewQueueHost.workerExited(id);
        if (queueBinding) markQueueSessionState(id, "retired");
        hostRuntime.clearRetiring(id);
        hostRuntime.forgetUse(id);
        if (hostRuntime.client(id) === client) hostRuntime.dropClient(id);
        if (!caps.closing()) {
          try {
            const current = store.get("session", id);
            store.put("session", { ...current, processPid: undefined });
          } catch {
            // Best effort: the session record may already be removed; shutdown proceeds either way.
          }
        }
      };
      void client.exited.then(cleanupOwner);

      try {
        let state = await client.request("get_state", {}, 15000);
        assertQueueBootPermit(id, queuePermit);
        if (
          session.model &&
          (state.model?.provider !== session.model.provider ||
            state.model?.id !== session.model.id)
        ) {
          await client.request("set_model", {
            provider: session.model.provider,
            modelId: session.model.id,
          });
        }
        if (
          session.thinkingLevel &&
          state.thinkingLevel !== session.thinkingLevel
        )
          await client.request("set_thinking_level", {
            level: session.thinkingLevel,
          });
        if (session.model || session.thinkingLevel)
          state = await client.request("get_state", {}, 15000);
        assertQueueBootPermit(id, queuePermit);
        const piFile = state.sessionFile;
        if (
          piFile &&
          !resolve(piFile).startsWith(resolve(options.root, "runtime") + "/")
        )
          throw new SuriError(
            "PATH_DENIED",
            "Runtime session escaped its reserved directory.",
          );
        store.put("session", {
          ...store.get("session", id),
          processPid: client.child.pid,
          piFile,
          piSessionId: state.sessionId,
          model: state.model
            ? { provider: state.model.provider, id: state.model.id }
            : undefined,
          thinkingLevel: state.thinkingLevel,
        });
        if (
          session.piFile &&
          store.snapshot(`session:${id}`).messages.length === 0
        ) {
          const h = await client.request("get_messages");
          for (const [i, m] of (h.messages ?? []).entries())
            publish(`session:${id}`, "message.upsert", {
              messageId: `history:${i}`,
              role: m.role,
              blocks: content(m.content, `history:${i}`),
              revision: 1,
              final: true,
            });
        }
        client.completeStartup();
        emit(id, "session.state", { phase: "idle" });
        return client;
      } catch (e) {
        if (queuePermit) queuePermit.active = false;
        emit(id, "session.state", { phase: "failed" });
        hostRuntime.markRetiring(id);
        try {
          await client.retireFailedStartup();
        } catch {
          // Best effort: a failed retirement must not mask the original startup error rethrown below.
        } finally {
          hostRuntime.clearRetiring(id);
        }
        throw e;
      }
    })();
    hostRuntime.setBoot(id, promise);
    try {
      return await promise;
    } finally {
      hostRuntime.clearBoot(id);
    }
  }
  return { startSession };
}
