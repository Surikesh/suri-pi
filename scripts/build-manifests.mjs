import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  open,
  mkdir,
  readdir,
  rename,
  rm,
  readFile,
  lstat,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  canonicalJson,
  canonicalInventory,
  UiIdentitySchema,
  HostIdentitySchema,
  ReadyPointerSchema,
} from "../packages/protocol/src/updates.ts";

export const digest = (bytes) =>
  createHash("sha256").update(bytes).digest("hex");
export class BuildPublicationError extends Error {
  constructor(code) {
    super(code);
    this.name = "BuildPublicationError";
    this.code = code;
  }
}
export async function atomicJson(path, value) {
  const temp = path + ".tmp-" + randomUUID();
  let handle;
  try {
    handle = await open(temp, "wx", 0o600);
    await handle.writeFile(canonicalJson(value) + "\n");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temp, path);
    const directory = await open(dirname(path), "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } finally {
    await handle?.close();
    await rm(temp, { force: true });
  }
}
export async function inventory(root, prefix = "", files = []) {
  if ((await lstat(root)).isSymbolicLink())
    throw new BuildPublicationError("BUILD_SYMLINK_DENIED");
  for (const entry of (await readdir(root, { withFileTypes: true })).sort(
    (a, b) => a.name.localeCompare(b.name),
  )) {
    const path = prefix + entry.name;
    if (entry.isDirectory())
      await inventory(join(root, entry.name), path + "/", files);
    else {
      if (!entry.isFile())
        throw new BuildPublicationError("BUILD_FILE_TYPE_INVALID");
      const fd = await open(
        join(root, entry.name),
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      try {
        const stat = await fd.stat();
        if (!stat.isFile() || stat.size > 64 * 1024 * 1024)
          throw new BuildPublicationError("BUILD_FILE_LIMIT");
        const bytes = await fd.readFile();
        await fd.sync();
        files.push({
          path,
          sha256: digest(bytes),
          bytes: bytes.length,
          executable: (stat.mode & 0o111) !== 0,
        });
        if (files.length > 10_000)
          throw new BuildPublicationError("BUILD_FILE_LIMIT");
      } finally {
        await fd.close();
      }
    }
  }
  return canonicalInventory(files);
}
export async function publishArtifact(
  base,
  stage,
  identity,
  createdAt = new Date().toISOString(),
) {
  identity =
    identity.kind === "ui"
      ? UiIdentitySchema.parse(identity)
      : HostIdentitySchema.parse(identity);
  identity.files = canonicalInventory(identity.files);
  const buildId = digest(canonicalJson(identity));
  const manifest = { buildId, identity, createdAt };
  await mkdir(base, { recursive: true, mode: 0o700 });
  const lock = join(base, ".publication-lock");
  try {
    await mkdir(lock, { mode: 0o700 });
  } catch (error) {
    if (error.code === "EEXIST")
      throw new BuildPublicationError("BUILD_PUBLICATION_BUSY");
    throw error;
  }
  try {
    let generation = 0;
    try {
      generation = ReadyPointerSchema.parse(
        JSON.parse(await readFile(join(base, "latest.json"), "utf8")),
      ).generation;
    } catch (error) {
      if (error.code !== "ENOENT")
        throw new BuildPublicationError("BUILD_POINTER_INVALID");
    }
    if (generation >= Number.MAX_SAFE_INTEGER)
      throw new BuildPublicationError("BUILD_GENERATION_EXHAUSTED");
    // Check staged bytes, not the mutable original producer inputs.
    if (canonicalJson(await inventory(stage)) !== canonicalJson(identity.files))
      throw new BuildPublicationError("BUILD_CONTENT_CHANGED");
    await atomicJson(join(stage, "manifest.json"), manifest);
    await atomicJson(join(stage, "ready.json"), { schema: 1, buildId });
    const target = join(base, buildId);
    try {
      await rename(stage, target);
    } catch (error) {
      if (!["EEXIST", "ENOTEMPTY"].includes(error.code)) throw error;
      const existing = JSON.parse(
        await readFile(join(target, "manifest.json"), "utf8"),
      );
      const files = (await inventory(target)).filter(
        (file) => !["manifest.json", "ready.json"].includes(file.path),
      );
      if (
        canonicalJson(existing.identity) !== canonicalJson(identity) ||
        canonicalJson(files) !== canonicalJson(identity.files)
      )
        throw new BuildPublicationError("BUILD_ID_COLLISION");
    }
    await atomicJson(join(base, "latest.json"), {
      schema: 1,
      generation: generation + 1,
      buildId,
    });
    return { ...manifest, path: target };
  } finally {
    await rm(lock, { recursive: true });
  }
}
export const updateCompatibility = {
  protocol: 1,
  hostMin: 2,
  hostMax: 2,
  checkpoint: 1,
  shellMin: 2,
};
export function artifactStage(kind, root = process.cwd()) {
  return resolve(root, ".build", kind, ".stage-" + randomUUID());
}
