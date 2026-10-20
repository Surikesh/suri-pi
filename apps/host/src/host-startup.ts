import {
  StartupBoundaryError,
  classifyStartupError,
  startupFailure,
} from "./preflight.js";
import type { ModernUpdates } from "./modern-updates.js";
import type { acquireLock } from "./resources.js";
import type { Storage } from "./storage.js";
import type { HostOptions } from "./host-types.js";

/**
 * Synchronous startup builders and classifiers. The awaits, registrations and
 * cleanup order of startHost stay in host.ts; these only build values and errors.
 */

/** Returns the async lock-release closure (captures the lock process). */
export function lockReleaser(lock: Awaited<ReturnType<typeof acquireLock>>) {
  return async () => {
    await new Promise<void>((resolve) => {
      if (lock.exitCode !== null) resolve();
      else {
        lock.once("exit", () => resolve());
        lock.stdin.end();
      }
    });
  };
}

export function savedCheckout(text: string, current: string | undefined) {
  const saved = JSON.parse(text);
  return typeof saved.path === "string" && saved.path.startsWith("/")
    ? saved.path
    : current;
}

/** Argument object for `ModernUpdates.create`. */
export function updatesArgs(
  options: HostOptions,
  checkout: string | undefined,
  instanceId: string,
  store: Storage,
  identity: Readonly<{ buildId: string; adapterId: string }> | undefined,
): Parameters<typeof ModernUpdates.create>[0] {
  return {
    root: options.root,
    helper: options.helper,
    assets: options.assets,
    checkout,
    instanceId,
    epoch: store.epoch,
    identity,
  };
}

export function listenerFailure(error: unknown) {
  return new StartupBoundaryError(
    (error as NodeJS.ErrnoException).code === "EADDRINUSE"
      ? startupFailure(
          "listener",
          "HOST_ADDRESS_CONFLICT",
          false,
          "The approved loopback address is occupied; no process was terminated.",
        )
      : classifyStartupError("listener"),
  );
}

export function checkControlPath(socketPath: string) {
  if (
    Buffer.byteLength(socketPath) >= (process.platform === "darwin" ? 104 : 108)
  )
    throw new StartupBoundaryError(
      startupFailure(
        "control",
        "CONTROL_PATH_TOO_LONG",
        false,
        "Use a shorter profile path for the private control socket.",
      ),
    );
}

export function controlBindFailure(error: unknown) {
  return error instanceof StartupBoundaryError
    ? error
    : new StartupBoundaryError(
        startupFailure(
          "control",
          "CONTROL_BIND_FAILED",
          false,
          "The private control socket could not bind; leave unknown processes unchanged.",
        ),
      );
}

export function endpointJson(
  hostId: string,
  origin: string,
  socketPath: string,
) {
  return JSON.stringify({
    v: 1,
    hostId,
    pid: process.pid,
    origin,
    socketPath,
  });
}
