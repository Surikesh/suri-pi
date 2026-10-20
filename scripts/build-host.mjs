import { cp, mkdir, readFile, rm, writeFile, lstat } from "node:fs/promises";
import { join, dirname, relative } from "node:path";
import {
  artifactStage,
  inventory,
  digest,
  publishArtifact,
  updateCompatibility,
  BuildPublicationError,
} from "./build-manifests.mjs";
import { canonicalJson } from "../packages/protocol/src/updates.ts";

// Positive runtime roots, independent from frontend/package dependencies.
const runtimeRoots = ["better-sqlite3", "node-pty", "ws", "zod"];
export function dependencyClosure(lock, roots = runtimeRoots) {
  const pending = roots.map((name) => ({ parent: "", name, optional: false }));
  const result = new Map();
  while (pending.length) {
    const next = pending.pop();
    let ancestor = next.parent;
    let path;
    for (;;) {
      const candidate = ancestor
        ? `${ancestor}/node_modules/${next.name}`
        : `node_modules/${next.name}`;
      if (lock.packages[candidate]) {
        path = candidate;
        break;
      }
      if (!ancestor) break;
      const nested = ancestor.lastIndexOf("/node_modules/");
      ancestor = nested < 0 ? "" : ancestor.slice(0, nested);
    }
    if (!path) {
      if (next.optional) continue;
      throw new BuildPublicationError("HOST_DEPENDENCY_LOCK_MISSING");
    }
    if (result.has(path)) continue;
    const metadata = lock.packages[path];
    if (
      metadata.link ||
      typeof metadata.version !== "string" ||
      typeof metadata.integrity !== "string" ||
      !metadata.integrity.startsWith("sha512-")
    )
      throw new BuildPublicationError("HOST_DEPENDENCY_LOCK_INVALID");
    result.set(path, {
      path,
      name: next.name,
      version: metadata.version,
      integrity: metadata.integrity,
      optional: next.optional,
    });
    for (const name of Object.keys({
      ...metadata.dependencies,
      ...metadata.optionalDependencies,
    }))
      pending.push({
        parent: path,
        name,
        optional: Object.hasOwn(metadata.optionalDependencies ?? {}, name),
      });
  }
  return [...result.values()].sort((a, b) => a.path.localeCompare(b.path));
}
export async function buildHost({
  root = process.cwd(),
  compiledRoot = join(root, "dist"),
  modern = false,
} = {}) {
  if (process.versions.node !== "24.15.0")
    throw new BuildPublicationError("HOST_NODE_VERSION_UNSUPPORTED");
  const stage = artifactStage("host", root);
  await mkdir(stage, { recursive: true, mode: 0o700 });
  try {
    for (const path of [
      "dist/apps/host/src",
      "dist/packages/pi-adapter/src",
      "dist/packages/model-chain/src",
      "dist/packages/protocol/src",
      "dist/native/suri-helper",
    ]) {
      await mkdir(dirname(join(stage, path)), { recursive: true });
      await cp(
        join(compiledRoot, path.slice("dist/".length)),
        join(stage, path),
        {
          recursive: true,
          dereference: false,
          filter: (path) => !path.endsWith(".map"),
        },
      );
    }
    await cp(
      join(root, "scripts/update-launcher.mjs"),
      join(stage, "launch.mjs"),
    );
    if (modern)
      await cp(
        join(root, "scripts/restart-worker.mjs"),
        join(stage, "restart-worker.mjs"),
      );
    const lock = JSON.parse(
      await readFile(join(root, "package-lock.json"), "utf8"),
    );
    const dependencies = [];
    for (const dependency of dependencyClosure(lock)) {
      const source = join(root, dependency.path);
      try {
        if (!(await lstat(source)).isDirectory())
          throw new BuildPublicationError("HOST_DEPENDENCY_TYPE_INVALID");
      } catch (error) {
        if (dependency.optional && error.code === "ENOENT") continue;
        throw error;
      }
      const installed = JSON.parse(
        await readFile(join(source, "package.json"), "utf8"),
      );
      if (
        installed.name !== dependency.name ||
        installed.version !== dependency.version
      )
        throw new BuildPublicationError("HOST_DEPENDENCY_VERSION_MISMATCH");
      await mkdir(dirname(join(stage, dependency.path)), { recursive: true });
      await cp(source, join(stage, dependency.path), {
        recursive: true,
        dereference: false,
        filter: (candidate) =>
          candidate === source ||
          (!relative(source, candidate).split("/").includes("node_modules") &&
            !candidate.endsWith(".map")),
      });
      dependencies.push(dependency);
    }
    await writeFile(
      join(stage, "package.json"),
      canonicalJson({
        type: "module",
        private: true,
        engines: { node: "24.15.0" },
      }),
    );
    await writeFile(
      join(stage, "dependencies.json"),
      canonicalJson(dependencies),
    );
    const files = await inventory(stage);
    return await publishArtifact(join(root, ".build/host"), stage, {
      schema: 1,
      kind: "host",
      // This staged host still exposes contract 1 until the complete loader and
      // transition protocol are connected. Never label foundation code contract 2.
      compatibility: {
        ...updateCompatibility,
        hostMin: modern ? 2 : 1,
        hostMax: modern ? 2 : 1,
        shellMin: modern ? 2 : 1,
      },
      storageSchema: 1,
      node: {
        version: process.versions.node,
        abi: process.versions.modules,
        platform: process.platform,
        arch: process.arch,
      },
      adapterId: digest(
        canonicalJson(
          files.filter((file) =>
            file.path.startsWith("dist/packages/pi-adapter/"),
          ),
        ),
      ),
      files,
    });
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}
