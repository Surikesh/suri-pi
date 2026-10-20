import { readFile, readdir, mkdir, cp, lstat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { SuriError, type Data } from "../../../packages/protocol/src/index.js";
export async function validateBuild(dir: string) {
  const manifest = JSON.parse(
    await readFile(join(dir, "manifest.json"), "utf8"),
  );
  if (
    !/^[a-zA-Z0-9_-]{1,80}$/.test(manifest.buildId) ||
    manifest.protocol !== 1 ||
    manifest.hostMin > 1 ||
    manifest.hostMax < 1
  )
    throw new SuriError(
      "CONFLICT",
      "This UI requires a host restart or incompatible protocol.",
    );
  for (const [path, hash] of Object.entries(manifest.assets)) {
    if (
      typeof path !== "string" ||
      path.startsWith("/") ||
      path.split("/").includes("..")
    )
      throw new SuriError("PATH_DENIED", "Invalid build path.");
    let current = dir;
    for (const part of path.split("/")) {
      current = join(current, part);
      if ((await lstat(current)).isSymbolicLink())
        throw new SuriError(
          "PATH_DENIED",
          "UI builds may not contain symlinks.",
        );
    }
    const got = createHash("sha256")
      .update(await readFile(join(dir, path)))
      .digest("hex");
    if (hash !== got)
      throw new SuriError("VALIDATION", "UI build integrity check failed.");
  }
  if (!manifest.assets["index.html"])
    throw new SuriError("VALIDATION", "UI entry is missing.");
  return manifest;
}
export class UiBuilds {
  constructor(
    readonly root: string,
    readonly bundled: string,
    public checkout?: string,
  ) {}
  async list() {
    if (!this.checkout) return { current: "bundled", previous: "bundled" };
    let dirs: string[] = [];
    try {
      dirs = await readdir(join(this.checkout, ".build/ui"));
    } catch {
      // No build directory yet: the list stays empty.
    }
    const valid: Data[] = [];
    for (const d of dirs) {
      try {
        valid.push(await validateBuild(join(this.checkout, ".build/ui", d)));
      } catch {
        // Invalid or partial build directories are skipped, not listed.
      }
    }
    valid.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return {
      current: "bundled",
      previous: "bundled",
      ready: valid[0]?.buildId,
    };
  }
  async import(id: string) {
    if (id === "bundled") return this.bundled;
    if (!this.checkout || !/^[a-zA-Z0-9_-]{1,80}$/.test(id))
      throw new SuriError(
        "PATH_DENIED",
        "No trusted UI checkout is associated.",
      );
    const source = join(this.checkout, ".build/ui", id);
    await validateBuild(source);
    const target = join(this.root, "ui-builds", id);
    await mkdir(join(this.root, "ui-builds"), { recursive: true, mode: 0o700 });
    await cp(source, target, {
      recursive: true,
      errorOnExist: false,
      force: false,
    });
    await validateBuild(target);
    return target;
  }
  path(id: string) {
    if (id === "bundled") return this.bundled;
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(id))
      throw new SuriError("PATH_DENIED", "Invalid build id.");
    return resolve(this.root, "ui-builds", id);
  }
}
