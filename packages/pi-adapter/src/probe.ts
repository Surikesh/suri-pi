import { createHash } from "node:crypto";
import { readFile, realpath, readdir } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { runtimeVersion } from "./runtime-version.js";
import {
  SuriError,
  runtimeVersions,
  type Data,
} from "../../protocol/src/index.js";

export async function probe(executable: string, expected: string) {
  if (!runtimeVersions.includes(expected as (typeof runtimeVersions)[number]))
    throw new SuriError(
      "RUNTIME_UNSUPPORTED",
      "This Pi version is not an accepted candidate.",
    );
  const path = await realpath(executable);
  const hash = createHash("sha256");
  let packageRoot = dirname(path);
  let metadata: Data | undefined;
  let metadataBytes: Buffer | undefined;
  for (let depth = 0; depth < 5; depth++) {
    try {
      const bytes = await readFile(join(packageRoot, "package.json"));
      const candidate = JSON.parse(bytes.toString("utf8"));
      if (candidate.name === "@earendil-works/pi-coding-agent") {
        metadata = candidate;
        metadataBytes = bytes;
        break;
      }
    } catch {
      // No readable package.json at this level: continue to the parent directory.
    }
    packageRoot = dirname(packageRoot);
  }
  if (
    metadata?.name !== "@earendil-works/pi-coding-agent" ||
    metadata.version !== expected ||
    !metadataBytes
  )
    throw new SuriError(
      "RUNTIME_UNSUPPORTED",
      "The runtime package identity is not supported.",
    );
  const declaredEntry =
    typeof metadata.bin === "string"
      ? metadata.bin
      : metadata.bin && typeof metadata.bin.pi === "string"
        ? metadata.bin.pi
        : undefined;
  if (!declaredEntry) {
    throw new SuriError(
      "RUNTIME_UNSUPPORTED",
      "The runtime package has no supported declared Pi entrypoint.",
    );
  }
  let canonicalEntry: string;
  try {
    canonicalEntry = await realpath(join(packageRoot, declaredEntry));
  } catch {
    throw new SuriError(
      "RUNTIME_UNAVAILABLE",
      "The declared Pi entrypoint is unavailable.",
    );
  }
  if (canonicalEntry !== path)
    throw new SuriError(
      "RUNTIME_UNSUPPORTED",
      "The selected executable is not the declared Pi entrypoint.",
    );
  hash.update("suri-pi-runtime-identity-v2\0");
  hash.update(metadataBytes);
  const executableBytes = await readFile(path);
  const executableSha256 = createHash("sha256")
    .update(executableBytes)
    .digest("hex");
  async function fingerprint(dir: string) {
    const entries = (await readdir(dir, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    for (const entry of entries) {
      if (entry.name === ".bin") continue;
      const file = join(dir, entry.name);
      if (entry.isSymbolicLink())
        throw new SuriError(
          "RUNTIME_UNSUPPORTED",
          "Runtime distribution contains a symlink.",
        );
      if (entry.isDirectory()) await fingerprint(file);
      else if (entry.isFile()) {
        hash.update(relative(packageRoot, file));
        hash.update("\0");
        hash.update(await readFile(file));
        hash.update("\0");
      } else
        throw new SuriError(
          "RUNTIME_UNSUPPORTED",
          "Runtime distribution contains an unsupported file type.",
        );
    }
  }
  await fingerprint(join(packageRoot, "dist"));
  try {
    const shrinkwrap = await readFile(join(packageRoot, "npm-shrinkwrap.json"));
    hash.update("npm-shrinkwrap.json\0");
    hash.update(shrinkwrap);
  } catch {
    throw new SuriError(
      "RUNTIME_UNSUPPORTED",
      "The runtime distribution has no dependency identity lock.",
    );
  }
  try {
    await fingerprint(join(packageRoot, "node_modules"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT")
      throw new SuriError(
        "RUNTIME_UNAVAILABLE",
        "The runtime dependency closure is unavailable.",
      );
    throw error;
  }
  const identity = hash.digest("hex");
  const reported = await runtimeVersion(path, packageRoot);
  if (!reported.ok)
    throw new SuriError(
      "RUNTIME_UNAVAILABLE",
      `Pi version check failed (${reported.category}). No prompt was sent.`,
    );
  if (reported.version !== expected)
    throw new SuriError(
      "RUNTIME_UNSUPPORTED",
      `Pi version mismatch: expected ${expected}, reported ${reported.version}.`,
    );
  return {
    executable: path,
    version: expected,
    identity,
    executableSha256,
    adapterIdentity: "suri-pi-adapter/v1" as const,
    status: "candidate",
  };
}
