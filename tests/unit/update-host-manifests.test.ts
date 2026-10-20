import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { buildHost, dependencyClosure } from "../../scripts/build-host.mjs";
async function put(root: string, path: string, text: string) {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), text);
}
describe("host identity inventory", () => {
  it("uses dependency closure, not unrelated UI/dev packages", () => {
    const metadata = { version: "1.0.0", integrity: "sha512-fixture" };
    const lock = {
      packages: {
        "node_modules/host": { ...metadata, dependencies: { nested: "1.0.0" } },
        "node_modules/host/node_modules/nested": metadata,
        "node_modules/unrelated": metadata,
      },
    };
    expect(
      dependencyClosure(lock, ["host"]).map((entry) => entry.path),
    ).toEqual(["node_modules/host", "node_modules/host/node_modules/nested"]);
    expect(() => dependencyClosure(lock, ["absent"])).toThrow(
      "HOST_DEPENDENCY_LOCK_MISSING",
    );
  });
  it("UI-only edits preserve host ID; adapter/dependency changes do not; staged dependencies are retained", async () => {
    const root = await mkdtemp(join(tmpdir(), "suri-host-manifest-"));
    try {
      for (const path of [
        "dist/apps/host/src/host.js",
        "dist/apps/host/src/cli.js",
        "dist/packages/pi-adapter/src/index.js",
        "dist/packages/model-chain/src/broker-framing.js",
        "dist/packages/protocol/src/index.js",
        "dist/native/suri-helper",
        "scripts/update-launcher.mjs",
        "dist/ui/index.html",
      ])
        await put(root, path, "fixture");
      const packages: Record<string, { version: string; integrity: string }> =
        {};
      for (const name of ["better-sqlite3", "node-pty", "ws", "zod"]) {
        packages[`node_modules/${name}`] = {
          version: "1.0.0",
          integrity: "sha512-fixture",
        };
        await put(
          root,
          `node_modules/${name}/package.json`,
          JSON.stringify({ name, version: "1.0.0" }),
        );
        await put(root, `node_modules/${name}/index.js`, "dependency fixture");
      }
      await put(root, "package-lock.json", JSON.stringify({ packages }));
      const a = await buildHost({ root });
      await put(root, "dist/ui/index.html", "changed UI only");
      const b = await buildHost({ root });
      expect(b.buildId).toBe(a.buildId);
      expect(
        b.identity.files.every((file) => !file.path.startsWith("dist/ui/")),
      ).toBe(true);
      await put(
        root,
        "dist/packages/pi-adapter/src/index.js",
        "changed adapter",
      );
      const c = await buildHost({ root });
      expect(c.buildId).not.toBe(a.buildId);
      expect(c.identity.adapterId).not.toBe(a.identity.adapterId);
      await put(
        root,
        "dist/packages/model-chain/src/broker-framing.js",
        "changed host-imported model-chain module",
      );
      const d = await buildHost({ root });
      expect(d.buildId).not.toBe(c.buildId);
      expect(d.identity.adapterId).toBe(c.identity.adapterId);
      await put(root, "node_modules/ws/index.js", "changed dependency");
      const e = await buildHost({ root });
      expect(e.buildId).not.toBe(d.buildId);
      expect(e.identity.adapterId).toBe(d.identity.adapterId);
      expect(
        await readFile(join(a.path, "node_modules/ws/index.js"), "utf8"),
      ).toBe("dependency fixture");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
