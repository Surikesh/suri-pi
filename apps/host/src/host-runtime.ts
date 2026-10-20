import type { PiClient } from "../../../packages/pi-adapter/src/index.js";
import {
  activePhases,
  SuriError,
} from "../../../packages/protocol/src/index.js";
import type { Storage } from "./storage.js";

/**
 * Sole owner of the runtime ledger: submissions, boots, last-use, retirement
 * marks and the idle reaper. `children` is the host-owned test seam, received
 * privately and never handed to another factory.
 */
export function createRuntime(caps: {
  children: Map<string, PiClient>;
  store: Storage;
  closing: () => boolean;
  queueBinding: (id: string) => unknown;
  hasInteraction: (id: string) => boolean;
  hasImageWrite: (id: string) => boolean;
}) {
  const { children, store } = caps;
  // Per-session reservation counts: overlapping submits release independently.
  const submissions = new Map<string, number>();
  const boots = new Map<string, Promise<PiClient>>();
  const lastRuntimeUse = new Map<string, number>();
  const retiring = new Set<string>();
  // Retain history, not idle OS processes. Active runs are never evicted.
  function reapIdleRuntimes(now = Date.now()) {
    for (const [id, client] of children) {
      const snapshot = store.snapshot(`session:${id}`);
      if (
        caps.closing() ||
        caps.queueBinding(id) ||
        retiring.has(id) ||
        boots.has(id) ||
        submissions.has(id) ||
        client.hasPendingRequests ||
        activePhases.has(snapshot.phase) ||
        snapshot.queue.length ||
        caps.hasImageWrite(id) ||
        caps.hasInteraction(id) ||
        !store.get("session", id).piFile ||
        now - (lastRuntimeUse.get(id) ?? now) < 15 * 60_000
      )
        continue;
      retiring.add(id);
      client.close();
    }
  }
  let idleRuntimeTimer: NodeJS.Timeout | undefined;
  /** `joinBoot` lets a resume wait on the owned boot that is still starting. */
  function idle(id: string, joinBoot = false) {
    const phase = store.snapshot(`session:${id}`).phase;
    if (joinBoot && phase === "starting" && boots.has(id)) return;
    if (activePhases.has(phase))
      throw new SuriError(
        "BUSY",
        "Stop the current run before changing this session.",
      );
  }
  return {
    reapIdleRuntimes,
    idle,
    startReaper() {
      idleRuntimeTimer = setInterval(reapIdleRuntimes, 30_000);
      idleRuntimeTimer.unref();
    },
    stopReaper() {
      clearInterval(idleRuntimeTimer);
    },
    touch(id: string) {
      lastRuntimeUse.set(id, Date.now());
    },
    forgetUse(id: string) {
      lastRuntimeUse.delete(id);
    },
    isRetiring: (id: string) => retiring.has(id),
    markRetiring(id: string) {
      retiring.add(id);
    },
    clearRetiring(id: string) {
      retiring.delete(id);
    },
    hasSubmission: (id: string) => submissions.has(id),
    addSubmission(id: string) {
      submissions.set(id, (submissions.get(id) ?? 0) + 1);
    },
    removeSubmission(id: string) {
      const left = (submissions.get(id) ?? 0) - 1;
      if (left > 0) submissions.set(id, left);
      else submissions.delete(id);
    },
    isBooting: (id: string) => boots.has(id),
    boot: (id: string) => boots.get(id),
    setBoot(id: string, promise: Promise<PiClient>) {
      boots.set(id, promise);
    },
    clearBoot(id: string) {
      boots.delete(id);
    },
    client: (id: string) => children.get(id),
    hasClient: (id: string) => children.has(id),
    setClient(id: string, client: PiClient) {
      children.set(id, client);
    },
    dropClient(id: string) {
      children.delete(id);
    },
    clients: () => [...children.values()],
    childCount: () => children.size,
    /** Sessions holding runtime work, in children, boots, submissions order. */
    workSessions: () => [
      ...children.keys(),
      ...boots.keys(),
      ...submissions.keys(),
    ],
  };
}
export type HostRuntime = ReturnType<typeof createRuntime>;
