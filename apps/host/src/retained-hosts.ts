import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { open, mkdir, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import {
  BuildIdSchema,
  HostManifestSchema,
  UiManifestSchema,
} from "../../../packages/protocol/src/updates.js";
import { validatePrivateArtifact } from "./update-artifacts.js";
import { writeUpdateFile } from "./update-state.js";
const Selection = z.strictObject({
  schema: z.literal(1),
  profileId: z.uuid(),
  activeId: BuildIdSchema,
  previousId: BuildIdSchema.nullable(),
  fallbackUiId: BuildIdSchema,
  origin: z.string().url(),
});
class RetainedHostFailure extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}
async function retainedSelection(root: string) {
  try {
    const fd = await open(
      join(root, "updates/host-selection.json"),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      const stat = await fd.stat();
      if (!stat.isFile() || stat.size > 16384) throw Error();
      return Selection.parse(JSON.parse(await fd.readFile("utf8")));
    } finally {
      await fd.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new RetainedHostFailure("HOST_SELECTION_CORRUPT");
  }
}
export class RetainedHosts {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly root: string) {}
  accept(input: {
    profileId: string;
    activeId: string;
    fallbackUiId: string;
    origin: string;
  }) {
    const operation = this.queue.then(async () => {
      const previous = await retainedSelection(this.root);
      if (
        previous?.activeId === input.activeId &&
        previous.origin === input.origin &&
        previous.profileId === input.profileId
      )
        return;
      const next = Selection.parse({
        schema: 1,
        ...input,
        previousId: previous?.activeId ?? null,
      });
      await mkdir(join(this.root, "updates"), { recursive: true, mode: 0o700 });
      try {
        await writeUpdateFile(
          join(this.root, "updates/host-selection.json"),
          JSON.stringify(next),
        );
      } catch {
        throw new RetainedHostFailure("HOST_SELECTION_WRITE_FAILED");
      }
    });
    // The queue only orders operations; each caller receives its own failure via operation, so the chain continues after one.
    this.queue = operation.catch(() => {});
    return operation;
  }
}
type HostHealth = {
  instanceId: string;
  pid?: unknown;
  hostBuildId?: unknown;
  uiBuildId?: unknown;
  uiContract?: unknown;
  product?: unknown;
  protocol?: unknown;
};

export async function launchRetained(
  root: string,
  health: () => Promise<HostHealth>,
  previous = false,
) {
  const selection = await retainedSelection(root);
  if (!selection) return false;
  const target = previous ? selection.previousId : selection.activeId;
  if (!target) throw new RetainedHostFailure("PREVIOUS_HOST_UNAVAILABLE");
  const state = await readFile(join(root, "updates/state.json"), "utf8")
    .then(JSON.parse)
    .catch(() => {
      throw new RetainedHostFailure("HOST_PROFILE_STATE_INVALID");
    });
  if (state.profileId !== selection.profileId)
    throw new RetainedHostFailure("HOST_PROFILE_CHANGED");
  return launchVerifiedHost(
    root,
    target,
    selection.fallbackUiId,
    selection.origin,
    health,
  );
}
export async function launchVerifiedHost(
  root: string,
  target: string,
  fallbackUiId: string,
  address: string,
  health: () => Promise<HostHealth>,
) {
  BuildIdSchema.parse(target);
  BuildIdSchema.parse(fallbackUiId);
  let origin: URL;
  try {
    origin = new URL(address);
  } catch {
    throw new RetainedHostFailure("HOST_SELECTION_CORRUPT");
  }
  if (
    origin.protocol !== "http:" ||
    origin.hostname !== "127.0.0.1" ||
    !origin.port ||
    origin.username ||
    origin.password ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash
  )
    throw new RetainedHostFailure("HOST_SELECTION_CORRUPT");
  const image = join(root, "host-builds", target),
    assets = join(root, "ui-builds", fallbackUiId);
  const hostManifest = HostManifestSchema.parse(
    await validatePrivateArtifact(image, "host", target),
  );
  const uiManifest = UiManifestSchema.parse(
    await validatePrivateArtifact(assets, "ui", fallbackUiId),
  );
  if (
    hostManifest.identity.compatibility.hostMin !== 2 ||
    hostManifest.identity.compatibility.hostMax !== 2 ||
    hostManifest.identity.compatibility.shellMin > 2 ||
    uiManifest.identity.compatibility.hostMin > 2 ||
    uiManifest.identity.compatibility.hostMax < 2
  )
    throw new RetainedHostFailure("NATIVE_REBUILD_REQUIRED");
  try {
    await promisify(execFile)(
      process.execPath,
      [join(image, "launch.mjs"), "--check"],
      {
        cwd: resolve(root),
        env: { ...process.env, SURI_DATA_DIR: root },
        timeout: 10000,
        maxBuffer: 8192,
      },
    );
  } catch {
    throw new RetainedHostFailure("HOST_TARGET_PREFLIGHT_FAILED");
  }
  const child = spawn(process.execPath, [join(image, "launch.mjs"), "serve"], {
    cwd: resolve(root),
    detached: true,
    stdio: "ignore",
    env: {
      ...process.env,
      SURI_DATA_DIR: root,
      SURI_ASSETS_DIR: assets,
      SURI_UI_BUILD_ID: fallbackUiId,
      SURI_PORT: origin.port,
    },
  });
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", () =>
      reject(new RetainedHostFailure("HOST_SPAWN_FAILED")),
    );
  });
  child.unref();
  for (let attempt = 0; attempt < 150; attempt++) {
    // An unreachable host is not healthy yet (null); the loop polls again.
    const current = await health().catch(() => null);
    if (current) {
      if (
        current.hostBuildId !== target ||
        current.uiBuildId !== fallbackUiId ||
        current.pid !== child.pid ||
        current.uiContract !== 2 ||
        current.product !== "suri-pi" ||
        current.protocol !== 1
      )
        throw new RetainedHostFailure("HOST_IDENTITY_CHANGED");
      return {
        pid: child.pid,
        instanceId: current.instanceId,
        hostBuildId: current.hostBuildId,
        uiBuildId: current.uiBuildId,
      };
    }
    // A missing or invalid launch status is treated as no failure report (null); the loop polls again.
    const status = await readFile(join(root, "run/update-launch.json"), "utf8")
      .then(JSON.parse)
      .catch(() => null);
    if (status?.stage === "failed" && status.pid === child.pid)
      throw new RetainedHostFailure(
        /^[A-Z_]{1,80}$/.test(status.code)
          ? status.code
          : "HOST_LAUNCH_STATUS_INVALID",
      );
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new RetainedHostFailure("HOST_START_TIMEOUT");
}
