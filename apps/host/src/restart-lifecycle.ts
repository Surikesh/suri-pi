import { execFile, spawn } from "node:child_process";
import { realpath } from "node:fs/promises";
import { promisify } from "node:util";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { HostManifestSchema } from "../../../packages/protocol/src/updates.js";
import { validatePrivateArtifact } from "./update-artifacts.js";
import {
  RestartCoordinator,
  RestartFailure,
  type WorkState,
} from "./restart-coordinator.js";
import { RestartHandoffs } from "./restart-handoff.js";
import { writeUpdateFile } from "./update-state.js";
import type { ModernUpdates } from "./modern-updates.js";

export async function createRestartLifecycle(options: {
  root: string;
  identity?: { buildId: string };
  modern: ModernUpdates;
  origin: () => string;
  work: () => WorkState;
}) {
  const { identity, modern } = options;
  const root = await realpath(options.root);
  const handoffs = new RestartHandoffs(root);
  const currentImage = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../../../..",
  );
  const restart = await new RestartCoordinator(root, {
    instanceId: modern.instanceId,
    profileId: modern.state.snapshot().profileId,
    runningBuildId: identity?.buildId,
    origin: options.origin,
    work: options.work,
    target: () => modern.restartTarget,
    uiBuildId: () => {
      const id = modern.state.snapshot().activeUiId;
      if (!id) throw new RestartFailure("UI_TARGET_UNAVAILABLE");
      return id;
    },
    clients: () => modern.onlineClients(),
    handoffs,
    preflight: async (id) => {
      if (
        !identity ||
        currentImage !== resolve(root, "host-builds", identity.buildId)
      )
        throw new RestartFailure("RETAINED_LAUNCHER_REQUIRED");
      const path = join(root, "host-builds", id);
      const manifest = HostManifestSchema.parse(
        await validatePrivateArtifact(path, "host", id),
      );
      if (
        manifest.identity.compatibility.hostMin !== 2 ||
        manifest.identity.compatibility.hostMax !== 2 ||
        manifest.identity.compatibility.shellMin > 2
      )
        throw new RestartFailure("NATIVE_REBUILD_REQUIRED");
      try {
        const { stdout } = await promisify(execFile)(
          process.execPath,
          [join(path, "launch.mjs"), "--check"],
          {
            cwd: resolve(root),
            env: { ...process.env, SURI_DATA_DIR: root },
            timeout: 10000,
            maxBuffer: 8192,
          },
        );
        if (JSON.parse(stdout).buildId !== id) throw Error();
      } catch {
        throw new RestartFailure("HOST_TARGET_PREFLIGHT_FAILED");
      }
    },
    dispatch: async (approval) => {
      const fallback = modern.state.snapshot().packagedFallbackUiId;
      if (!identity || !fallback)
        throw new RestartFailure("RETAINED_LAUNCHER_REQUIRED");
      await writeUpdateFile(
        join(root, "run", "restart-" + approval.operationId + ".json"),
        JSON.stringify({
          operationId: approval.operationId,
          targetBuildId: approval.targetBuildId,
          fromInstanceId: approval.fromInstanceId,
          stage: "worker-spawn",
          code: "PENDING",
          oldHostState: "running",
          retryable: false,
          action: "none",
          at: new Date().toISOString(),
        }),
      );
      const child = spawn(
        process.execPath,
        [join(currentImage, "launch.mjs"), "restart-worker"],
        {
          cwd: resolve(root),
          detached: true,
          env: {
            ...process.env,
            SURI_DATA_DIR: root,
            SURI_ASSETS_DIR: join(root, "ui-builds", fallback),
            SURI_RESTART_OPERATION: approval.operationId,
          },
          stdio: "ignore",
        },
      );
      await new Promise<void>((resolve, reject) => {
        child.once("spawn", resolve);
        child.once("error", () =>
          reject(new RestartFailure("RESTART_WORKER_SPAWN_FAILED")),
        );
      });
      child.unref();
    },
  }).load();
  modern.restart = restart;
  return { restart, handoffs };
}
