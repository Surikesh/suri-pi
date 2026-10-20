import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { hashRecord } from "./review-queue-digest.js";
import { ReviewQueueRuntimeError } from "./review-queue-error.js";
import { contains, makeReadonly, runBounded } from "./review-queue-io.js";

const MAX_CANDIDATE_FILES = 20_000;
const MAX_CANDIDATE_BYTES = 256 * 1024 * 1024;

export async function candidateDigest(
  root: string,
  helper = resolve("dist/native/suri-helper"),
): Promise<string> {
  const source = await realpath(root);
  const parent = await mkdir(join(tmpdir(), "suri-review-digest"), {
    recursive: true,
    mode: 0o700,
  }).then(() => join(tmpdir(), "suri-review-digest", randomUUID()));
  await mkdir(parent, { mode: 0o700 });
  const canonicalTarget = await realpath(parent);
  try {
    await secureCopy(helper, source, canonicalTarget);
    return await digestTrustedCandidate(canonicalTarget);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
}

export async function snapshotCandidate(
  source: string,
  snapshotRoot: string,
  expectedDigest: string,
  helper: string,
  storageRoot: string,
) {
  const target = join(snapshotRoot, `${expectedDigest}-${randomUUID()}`);
  const canonicalTarget = await secureDirectory(helper, storageRoot, target);
  try {
    await secureCopy(helper, source, canonicalTarget);
    const actual = await digestTrustedCandidate(canonicalTarget);
    if (actual !== expectedDigest)
      throw new ReviewQueueRuntimeError(
        "candidate_digest_mismatch",
        "Candidate bytes do not match the immutable review identity.",
      );
    await makeReadonly(canonicalTarget);
    return canonicalTarget;
  } catch (error) {
    await rm(target, { recursive: true, force: true });
    throw error;
  }
}

export async function secureDirectory(
  helper: string,
  storageRoot: string,
  target: string,
) {
  const configuredRoot = resolve(storageRoot);
  const canonicalRoot = await realpath(configuredRoot);
  const absoluteTarget = resolve(target);
  if (!contains(configuredRoot, absoluteTarget))
    throw new ReviewQueueRuntimeError(
      "path_escape",
      "Queue-owned storage escaped its host root.",
    );
  const relativeTarget = relative(configuredRoot, absoluteTarget);
  const canonicalTarget = join(canonicalRoot, relativeTarget);
  const result = await runBounded(helper, [
    "queue-mkdir",
    canonicalRoot,
    relativeTarget,
  ]);
  if (result.code !== 0)
    throw new ReviewQueueRuntimeError(
      "path_denied",
      "Descriptor-relative directory creation failed closed.",
    );
  return realpath(canonicalTarget);
}

async function secureCopy(helper: string, source: string, target: string) {
  const result = await runBounded(helper, ["queue-copy", source, target]);
  if (result.code === 8)
    throw new ReviewQueueRuntimeError(
      "candidate_symlink_denied",
      "Immutable candidates cannot contain symlinks.",
    );
  if (result.code === 9)
    throw new ReviewQueueRuntimeError(
      "candidate_limit_exceeded",
      "Immutable candidate exceeds the bounded snapshot limit.",
    );
  if (result.code === 7)
    throw new ReviewQueueRuntimeError(
      "candidate_changed",
      "Candidate changed while the immutable snapshot was copied.",
    );
  if (result.code !== 0)
    throw new ReviewQueueRuntimeError(
      "candidate_copy_denied",
      "Descriptor-relative candidate copy failed closed.",
    );
}

async function digestTrustedCandidate(source: string) {
  const hash = createHash("sha256");
  let files = 0;
  let bytes = 0;
  const visit = async (relativePath: string): Promise<void> => {
    const directory = join(source, relativePath);
    const entries = (await readdir(directory, { withFileTypes: true })).sort(
      (a, b) => a.name.localeCompare(b.name),
    );
    for (const entry of entries) {
      const child = relativePath ? join(relativePath, entry.name) : entry.name;
      const path = join(source, child);
      if (entry.isSymbolicLink())
        throw new ReviewQueueRuntimeError(
          "candidate_symlink_denied",
          "Immutable candidates cannot contain symlinks.",
        );
      if (entry.isDirectory()) {
        hashRecord(hash, "d", child, Buffer.alloc(0));
        await visit(child);
        continue;
      }
      if (!entry.isFile())
        throw new ReviewQueueRuntimeError(
          "candidate_type_denied",
          "Immutable candidates can contain only directories and regular files.",
        );
      const handle = await open(
        path,
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      let data: Buffer;
      try {
        const before = await handle.stat();
        data = await handle.readFile();
        const after = await handle.stat();
        if (
          before.dev !== after.dev ||
          before.ino !== after.ino ||
          before.size !== after.size ||
          before.mtimeMs !== after.mtimeMs ||
          before.ctimeMs !== after.ctimeMs
        )
          throw new ReviewQueueRuntimeError(
            "candidate_changed",
            "Candidate changed while it was hashed.",
          );
      } finally {
        await handle.close();
      }
      files += 1;
      bytes += data.length;
      if (files > MAX_CANDIDATE_FILES || bytes > MAX_CANDIDATE_BYTES)
        throw new ReviewQueueRuntimeError(
          "candidate_limit_exceeded",
          "Immutable candidate exceeds the bounded snapshot limit.",
        );
      hashRecord(hash, "f", child, data);
    }
  };
  await visit("");
  return hash.digest("hex");
}
