import { randomUUID, createHash } from "node:crypto";
import { cp, lstat, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type {
  ActiveRelease,
  LocalRelease,
  ReadyMarker,
} from "./local-release-types.js";
import {
  collectFiles,
  contained,
  exists,
  parseManifest,
  readRegularBytes,
  rejectSymlinks,
  releaseFailure,
  validateDependencyClosure,
  validateInstalledRelease,
  validatePackagePayload,
  validateReleaseName,
} from "./local-release-validate.js";

async function writeActive(releases: string, active: ActiveRelease) {
  const path = join(releases, "active.json");
  const temporary = join(releases, `.active-${randomUUID()}.json`);
  await writeFile(temporary, JSON.stringify(active) + "\n", { mode: 0o600 });
  await rename(temporary, path);
}

async function readActive(
  releases: string,
): Promise<ActiveRelease | undefined> {
  try {
    const active = JSON.parse(
      (await readRegularBytes(join(releases, "active.json"))).toString("utf8"),
    );
    if (
      !validateReleaseName(active.release) ||
      (active.previous !== undefined && !validateReleaseName(active.previous))
    )
      throw releaseFailure("RELEASE_ACTIVE_MARKER_INVALID");
    return active;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return undefined;
    throw (error as Error)?.name === "LocalReleaseError"
      ? error
      : releaseFailure("RELEASE_ACTIVE_MARKER_INVALID");
  }
}

async function withActivationLock<T>(
  releases: string,
  operation: () => Promise<T>,
) {
  const lock = join(releases, ".activation-lock");
  for (let attempt = 0; ; attempt++) {
    try {
      await mkdir(lock);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "EEXIST" || attempt >= 100)
        throw releaseFailure("RELEASE_ACTIVATION_BUSY");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  try {
    return await operation();
  } finally {
    await rm(lock, { recursive: true, force: true });
  }
}

export async function prepareLocalRelease(options: {
  packageRoot: string;
  dataRoot: string;
}): Promise<LocalRelease> {
  const rootStat = await lstat(options.packageRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink())
    throw releaseFailure("RELEASE_TARGET_INVALID");
  const packageJson = JSON.parse(
    (
      await readRegularBytes(join(options.packageRoot, "package.json"))
    ).toString("utf8"),
  );
  const manifestPath = join(options.packageRoot, "release-manifest.json");
  if (packageJson.name !== "suri-local-preview-private") {
    return {
      root: options.packageRoot,
      cli: join(options.packageRoot, "dist/apps/host/src/cli.js"),
      assets: join(options.packageRoot, "dist/ui"),
      helper: join(options.packageRoot, "dist/native/suri-helper"),
      immutable: false,
    };
  }
  if (!(await exists(manifestPath)))
    throw releaseFailure("RELEASE_MANIFEST_MISSING");
  await rejectSymlinks(options.packageRoot);
  const manifestBytes = await readRegularBytes(manifestPath);
  const manifest = parseManifest(manifestBytes);
  if (manifest.productVersion !== packageJson.version)
    throw releaseFailure("RELEASE_VERSION_MISMATCH");
  await validatePackagePayload(options.packageRoot, manifest);
  await validateDependencyClosure(options.packageRoot, manifest);
  const manifestSha256 = createHash("sha256")
    .update(manifestBytes)
    .digest("hex");
  const shortHash = manifestSha256.slice(0, 16);
  const releases = join(options.dataRoot, "releases");
  await mkdir(releases, { recursive: true, mode: 0o700 });
  const release = `${packageJson.version}-${shortHash}`;
  if (!validateReleaseName(release))
    throw releaseFailure("RELEASE_VERSION_INVALID");
  const target = join(releases, release);
  if (!(await exists(target))) {
    const temporary = join(releases, `.staging-${randomUUID()}`);
    try {
      await mkdir(temporary, { mode: 0o700 });
      for (const file of manifest.files) {
        const destination = contained(temporary, file.path);
        await mkdir(dirname(destination), { recursive: true });
        await cp(contained(options.packageRoot, file.path), destination, {
          dereference: false,
        });
      }
      await cp(manifestPath, join(temporary, "release-manifest.json"));
      const files = await collectFiles(temporary);
      const ready: ReadyMarker = { schema: 1, manifestSha256, files };
      await writeFile(join(temporary, ".ready"), JSON.stringify(ready) + "\n", {
        mode: 0o600,
      });
      await validateInstalledRelease(temporary);
      try {
        await rename(temporary, target);
      } catch (error) {
        if (
          (error as NodeJS.ErrnoException)?.code !== "EEXIST" &&
          (error as NodeJS.ErrnoException)?.code !== "ENOTEMPTY"
        )
          throw error;
      }
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }
  await validateInstalledRelease(target);
  await withActivationLock(releases, async () => {
    const active = await readActive(releases);
    await writeActive(releases, {
      release,
      ...(active?.release && active.release !== release
        ? { previous: active.release }
        : active?.previous
          ? { previous: active.previous }
          : {}),
    });
  });
  return {
    root: target,
    cli: join(target, "bin/suri"),
    assets: join(target, "dist/ui"),
    helper: join(target, "dist/native/suri-helper"),
    immutable: true,
  };
}

export async function rollbackLocalRelease(
  dataRoot: string,
): Promise<LocalRelease> {
  const releases = join(dataRoot, "releases");
  return withActivationLock(releases, async () => {
    const active = await readActive(releases);
    if (!active?.previous) throw releaseFailure("RELEASE_PREVIOUS_UNAVAILABLE");
    const target = join(releases, active.previous);
    await validateInstalledRelease(target);
    await writeActive(releases, {
      release: active.previous,
      previous: active.release,
    });
    return {
      root: target,
      cli: join(target, "bin/suri"),
      assets: join(target, "dist/ui"),
      helper: join(target, "dist/native/suri-helper"),
      immutable: true,
    };
  });
}
