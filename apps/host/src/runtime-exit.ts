import type { PiClient } from "../../../packages/pi-adapter/src/index.js";
import { SuriError } from "../../../packages/protocol/src/index.js";

/** Grace after stdin EOF before SIGTERM, and after each signal before escalating. */
const RUNTIME_EXIT_GRACE_MS = 5000;
const RUNTIME_EXIT_SIGNAL_MS = 2000;

type OwnedRuntime = Pick<PiClient, "child" | "exited" | "close">;

async function exitedWithin(runtime: OwnedRuntime, timeout: number) {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      runtime.exited.then(() => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), timeout);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function signalGroup(runtime: OwnedRuntime, signal: "SIGTERM" | "SIGKILL") {
  const { pid, exitCode } = runtime.child;
  if (!pid || exitCode !== null) return;
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

/**
 * Close an owned Pi child and wait for it to exit within a deadline: stdin EOF,
 * then SIGTERM, then SIGKILL to its process group. If the child is still alive
 * after SIGKILL the call throws RUNTIME_EXIT_TIMEOUT so the caller keeps
 * ownership instead of treating the child as gone.
 */
export async function closeAndRetire(
  runtime: OwnedRuntime,
  grace = RUNTIME_EXIT_GRACE_MS,
  signalWait = RUNTIME_EXIT_SIGNAL_MS,
) {
  runtime.close();
  if (await exitedWithin(runtime, grace)) return;
  signalGroup(runtime, "SIGTERM");
  if (await exitedWithin(runtime, signalWait)) return;
  signalGroup(runtime, "SIGKILL");
  if (await exitedWithin(runtime, signalWait)) return;
  throw new SuriError(
    "RUNTIME_EXIT_TIMEOUT",
    "An owned runtime did not exit after SIGKILL.",
    true,
  );
}
