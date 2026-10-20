import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import { join, posix, relative, resolve, sep } from "node:path";
import type {
  ManifestFile,
  ReadyMarker,
  ReleaseManifest,
} from "./local-release-types.js";
const releaseNamePattern = /^[A-Za-z0-9][A-Za-z0-9._-]*-[a-f0-9]{16}$/;
const shaPattern = /^[a-f0-9]{64}$/;
const requiredPayload = [
  "bin/suri",
  "package.json",
  "npm-shrinkwrap.json",
  "release-shrinkwrap.json",
  "THIRD_PARTY_NOTICES.md",
  "dist/apps/host/src/cli.js",
  "dist/ui/index.html",
  "dist/native/suri-helper",
];

export function releaseFailure(code: string): Error {
  const error = new Error(code);
  error.name = "LocalReleaseError";
  return error;
}

export async function exists(path: string) {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

function validRelativePath(path: unknown): path is string {
  return (
    typeof path === "string" &&
    path.length > 0 &&
    path.length <= 4096 &&
    !path.includes("\\") &&
    !path.includes("\0") &&
    !path.startsWith("/") &&
    posix.normalize(path) === path &&
    !path.split("/").includes("..") &&
    !path.split("/").includes(".")
  );
}

export function contained(root: string, path: string) {
  const base = resolve(root);
  const candidate = resolve(root, path);
  if (candidate !== base && !candidate.startsWith(base + sep))
    throw releaseFailure("RELEASE_PATH_ESCAPE");
  return candidate;
}

export function parseManifest(bytes: Buffer): ReleaseManifest {
  let value: {
    schema?: unknown;
    product?: unknown;
    productVersion?: unknown;
    files?: unknown;
    dependencies?: unknown;
  };
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw releaseFailure("RELEASE_MANIFEST_INVALID");
  }
  if (
    value?.schema !== 1 ||
    value?.product !== "suri-pi" ||
    typeof value?.productVersion !== "string" ||
    !Array.isArray(value?.files) ||
    !Array.isArray(value?.dependencies)
  )
    throw releaseFailure("RELEASE_MANIFEST_INVALID");
  const paths = new Set<string>();
  for (const file of value.files) {
    if (
      !validRelativePath(file?.path) ||
      !Number.isSafeInteger(file?.bytes) ||
      file.bytes < 0 ||
      !shaPattern.test(file?.sha256) ||
      typeof file?.executable !== "boolean" ||
      paths.has(file.path) ||
      [...paths].some(
        (path) =>
          path.startsWith(`${file.path}/`) || file.path.startsWith(`${path}/`),
      )
    )
      throw releaseFailure("RELEASE_MANIFEST_INVALID");
    paths.add(file.path);
  }
  for (const required of requiredPayload)
    if (!paths.has(required))
      throw releaseFailure("RELEASE_PAYLOAD_INCOMPLETE");
  const dependencyPaths = new Set<string>();
  for (const dependency of value.dependencies) {
    if (
      !validRelativePath(dependency?.path) ||
      !dependency.path.startsWith("node_modules/") ||
      typeof dependency?.name !== "string" ||
      typeof dependency?.version !== "string" ||
      typeof dependency?.integrity !== "string" ||
      !dependency.integrity.startsWith("sha512-") ||
      dependencyPaths.has(dependency.path)
    )
      throw releaseFailure("RELEASE_DEPENDENCY_MANIFEST_INVALID");
    dependencyPaths.add(dependency.path);
  }
  return value as ReleaseManifest;
}

export async function readRegularBytes(path: string) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink())
    throw releaseFailure("RELEASE_FILE_TYPE_INVALID");
  return readFile(path);
}

async function regularFile(path: string, expected?: ManifestFile) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink())
    throw releaseFailure("RELEASE_FILE_TYPE_INVALID");
  const bytes = await readFile(path);
  const actual: ManifestFile = {
    path: expected?.path ?? "",
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    executable: (stat.mode & 0o111) !== 0,
  };
  if (
    expected &&
    (actual.bytes !== expected.bytes ||
      actual.sha256 !== expected.sha256 ||
      actual.executable !== expected.executable)
  )
    throw releaseFailure("RELEASE_CONTENT_MISMATCH");
  return actual;
}

export async function rejectSymlinks(path: string): Promise<void> {
  const stat = await lstat(path);
  if (stat.isSymbolicLink()) throw releaseFailure("RELEASE_SYMLINK_DENIED");
  if (stat.isDirectory()) {
    for (const entry of await readdir(path))
      await rejectSymlinks(join(path, entry));
  } else if (!stat.isFile()) throw releaseFailure("RELEASE_FILE_TYPE_INVALID");
}

export async function collectFiles(
  root: string,
  path = root,
): Promise<ManifestFile[]> {
  const result: ManifestFile[] = [];
  async function visit(candidate: string) {
    const stat = await lstat(candidate);
    if (stat.isSymbolicLink()) throw releaseFailure("RELEASE_SYMLINK_DENIED");
    if (stat.isDirectory()) {
      for (const entry of (await readdir(candidate)).sort())
        await visit(join(candidate, entry));
      return;
    }
    if (!stat.isFile()) throw releaseFailure("RELEASE_FILE_TYPE_INVALID");
    const path = relative(root, candidate).split(sep).join("/");
    if (path === ".ready") return;
    const actual = await regularFile(candidate);
    result.push({ ...actual, path });
  }
  await visit(path);
  return result;
}

function sameFiles(left: ManifestFile[], right: ManifestFile[]) {
  return (
    left.length === right.length &&
    left.every((file, index) =>
      (["path", "bytes", "sha256", "executable"] as const).every(
        (key) => file[key] === right[index]?.[key],
      ),
    )
  );
}

export async function validatePackagePayload(
  packageRoot: string,
  manifest: ReleaseManifest,
) {
  await rejectSymlinks(packageRoot);
  for (const file of manifest.files)
    await regularFile(contained(packageRoot, file.path), file);
  const actual = (await collectFiles(packageRoot))
    .filter((file) => file.path !== "release-manifest.json")
    .sort((a, b) => a.path.localeCompare(b.path));
  const expected = [...manifest.files].sort((a, b) =>
    a.path.localeCompare(b.path),
  );
  if (!sameFiles(actual, expected))
    throw releaseFailure("RELEASE_PAYLOAD_NOT_EXACT");
}

export async function validateDependencyClosure(
  packageRoot: string,
  manifest: ReleaseManifest,
) {
  type Lock = {
    packages?: Record<string, { version?: unknown; integrity?: unknown }>;
  };
  let npmLock: Lock;
  let releaseLock: Lock;
  try {
    const npmBytes = await readRegularBytes(
      join(packageRoot, "npm-shrinkwrap.json"),
    );
    const releaseBytes = await readRegularBytes(
      join(packageRoot, "release-shrinkwrap.json"),
    );
    if (!npmBytes.equals(releaseBytes))
      throw releaseFailure("RELEASE_DEPENDENCY_LOCK_MISMATCH");
    npmLock = JSON.parse(npmBytes.toString("utf8"));
    releaseLock = JSON.parse(releaseBytes.toString("utf8"));
  } catch (error) {
    if ((error as Error)?.name === "LocalReleaseError") throw error;
    throw releaseFailure("RELEASE_DEPENDENCY_LOCK_MISSING");
  }
  for (const dependency of manifest.dependencies) {
    const npmLocked = npmLock?.packages?.[dependency.path];
    const releaseLocked = releaseLock?.packages?.[dependency.path];
    if (
      npmLocked?.version !== dependency.version ||
      npmLocked?.integrity !== dependency.integrity ||
      releaseLocked?.version !== dependency.version ||
      releaseLocked?.integrity !== dependency.integrity
    )
      throw releaseFailure("RELEASE_DEPENDENCY_IDENTITY_MISMATCH");
    let metadata: { name?: unknown; version?: unknown };
    try {
      metadata = JSON.parse(
        (
          await readRegularBytes(
            contained(packageRoot, `${dependency.path}/package.json`),
          )
        ).toString("utf8"),
      );
    } catch {
      throw releaseFailure("RELEASE_DEPENDENCY_IDENTITY_MISMATCH");
    }
    if (
      metadata?.name !== dependency.name ||
      metadata?.version !== dependency.version
    )
      throw releaseFailure("RELEASE_DEPENDENCY_IDENTITY_MISMATCH");
  }
}

export async function validateInstalledRelease(
  target: string,
): Promise<{ manifest: ReleaseManifest; manifestSha256: string }> {
  const rootStat = await lstat(target);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink())
    throw releaseFailure("RELEASE_TARGET_INVALID");
  const manifestBytes = await readRegularBytes(
    join(target, "release-manifest.json"),
  );
  const manifest = parseManifest(manifestBytes);
  const manifestSha256 = createHash("sha256")
    .update(manifestBytes)
    .digest("hex");
  let ready: ReadyMarker;
  try {
    ready = JSON.parse(
      (await readRegularBytes(join(target, ".ready"))).toString("utf8"),
    );
  } catch {
    throw releaseFailure("RELEASE_NOT_READY");
  }
  if (
    ready?.schema !== 1 ||
    ready.manifestSha256 !== manifestSha256 ||
    !Array.isArray(ready.files)
  )
    throw releaseFailure("RELEASE_READY_INVALID");
  const actual = (await collectFiles(target)).sort((a, b) =>
    a.path.localeCompare(b.path),
  );
  const expected = [...ready.files].sort((a, b) =>
    a.path.localeCompare(b.path),
  );
  if (!sameFiles(actual, expected))
    throw releaseFailure("RELEASE_INTEGRITY_FAILED");
  return { manifest, manifestSha256 };
}

export function validateReleaseName(value: unknown): value is string {
  return typeof value === "string" && releaseNamePattern.test(value);
}
