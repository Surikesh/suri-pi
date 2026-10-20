import { build } from "vite";
import { mkdir, readFile, realpath, rm, cp } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  artifactStage,
  inventory,
  publishArtifact,
  updateCompatibility,
} from "./build-manifests.mjs";

export async function buildUi({
  root = process.cwd(),
  compatibilityOutput = false,
} = {}) {
  const stage = artifactStage("ui", root);
  await mkdir(stage, { recursive: true, mode: 0o700 });
  try {
    await build({
      root: join(root, "apps/web"),
      base: "./",
      build: { outDir: stage, emptyOutDir: true },
    });
    const html = await readFile(join(stage, "index.html"), "utf8");
    const entry = html.match(/<script\b[^>]*\bsrc="\.\/([^"]+)"/)?.[1];
    if (!entry) throw new Error("BUILD_ENTRY_MISSING");
    const candidate = await publishArtifact(resolve(root, ".build/ui"), stage, {
      schema: 1,
      kind: "ui",
      compatibility: updateCompatibility,
      entry,
      files: await inventory(stage),
    });
    if (compatibilityOutput) {
      // Legacy package input only; modern selection must use the immutable store.
      const destination = resolve(root, "dist/ui");
      await rm(destination, { recursive: true, force: true });
      await cp(candidate.path, destination, { recursive: true });
    }
    return candidate;
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}
if (
  process.argv[1] &&
  import.meta.url ===
    pathToFileURL(await realpath(resolve(process.argv[1]))).href
) {
  const candidate = await buildUi({
    compatibilityOutput: process.argv.includes("--compatibility-output"),
  });
  console.log("Built UI candidate (not activated): " + candidate.buildId);
}
