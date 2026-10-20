import { it, expect } from "vitest";
import {
  mkdtemp,
  writeFile,
  mkdir,
  rm,
  unlink,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { UiBuilds, validateBuild } from "../../apps/host/src/ui-builds.js";
it("imports immutable compatible builds and rejects corruption, incompatibility and symlinks", async () => {
  const root = await mkdtemp(join(tmpdir(), "suri-ui-build-"));
  const source = join(root, "checkout/.build/ui/fixture");
  await mkdir(source, { recursive: true });
  const html = "<html>synthetic candidate</html>";
  const manifest = {
    buildId: "fixture",
    protocol: 1,
    hostMin: 1,
    hostMax: 1,
    createdAt: new Date().toISOString(),
    assets: { "index.html": createHash("sha256").update(html).digest("hex") },
  };
  try {
    await writeFile(join(source, "index.html"), html);
    await writeFile(join(source, "manifest.json"), JSON.stringify(manifest));
    const ui = new UiBuilds(
      join(root, "data"),
      join(root, "bundled"),
      join(root, "checkout"),
    );
    expect((await ui.list()).ready).toBe("fixture");
    const imported = await ui.import("fixture");
    expect((await validateBuild(imported)).buildId).toBe("fixture");
    await writeFile(join(source, "index.html"), "broken candidate");
    await expect(ui.import("fixture")).rejects.toThrow("integrity");
    expect((await validateBuild(imported)).buildId).toBe("fixture");
    await writeFile(
      join(source, "manifest.json"),
      JSON.stringify({ ...manifest, protocol: 2 }),
    );
    await expect(validateBuild(source)).rejects.toThrow("incompatible");
    await writeFile(join(source, "manifest.json"), JSON.stringify(manifest));
    await unlink(join(source, "index.html"));
    await symlink(join(imported, "index.html"), join(source, "index.html"));
    await expect(validateBuild(source)).rejects.toThrow("symlinks");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
