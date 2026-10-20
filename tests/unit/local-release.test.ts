import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  lstat,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  prepareLocalRelease,
  rollbackLocalRelease,
} from "../../apps/host/src/local-release.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

const payloadPaths = [
  "bin/suri",
  "dist/apps/host/src/cli.js",
  "dist/ui/index.html",
  "dist/native/suri-helper",
  "THIRD_PARTY_NOTICES.md",
  "npm-shrinkwrap.json",
  "release-shrinkwrap.json",
  "package.json",
];

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "suri-release-"));
  roots.push(root);
  const project = join(root, "project");
  const projectModules = join(project, "node_modules");
  const packageRoot = join(projectModules, "suri-local-preview-private");
  const modules = join(packageRoot, "node_modules");
  for (const directory of [
    "dist/apps/host/src",
    "dist/ui",
    "dist/native",
    "bin",
  ])
    await mkdir(join(packageRoot, directory), { recursive: true });
  await mkdir(join(modules, "dependency"), { recursive: true });
  await mkdir(join(projectModules, "unrelated-sibling"), { recursive: true });
  await mkdir(join(projectModules, "matching-sibling"), { recursive: true });
  await mkdir(
    join(modules, "node-pty/prebuilds", `${process.platform}-${process.arch}`),
    { recursive: true },
  );
  await writeFile(
    join(packageRoot, "package.json"),
    JSON.stringify({ name: "suri-local-preview-private", version: "0.1.0" }),
  );
  await writeFile(join(packageRoot, "npm-shrinkwrap.json"), "{}\n");
  await writeFile(join(packageRoot, "release-shrinkwrap.json"), "{}\n");
  await writeFile(join(packageRoot, "THIRD_PARTY_NOTICES.md"), "notices\n");
  await writeFile(join(packageRoot, "bin/suri"), "#!/usr/bin/env node\n");
  await chmod(join(packageRoot, "bin/suri"), 0o755);
  await writeFile(join(packageRoot, "dist/ui/index.html"), "<script></script>");
  await writeFile(join(packageRoot, "dist/native/suri-helper"), "helper");
  await chmod(join(packageRoot, "dist/native/suri-helper"), 0o755);
  await writeFile(join(packageRoot, "dist/apps/host/src/cli.js"), "export {};");
  await writeFile(
    join(modules, "dependency/package.json"),
    '{"name":"dependency","version":"1.0.0"}',
  );
  await writeFile(join(modules, "dependency/index.js"), "module.exports = 1;");
  await writeFile(
    join(projectModules, "unrelated-sibling/package.json"),
    '{"name":"unrelated-sibling","version":"1.0.0"}',
  );
  await writeFile(
    join(projectModules, "matching-sibling/package.json"),
    '{"name":"dependency","version":"1.0.0"}',
  );
  await writeFile(
    join(projectModules, "matching-sibling/index.js"),
    "module.exports = 'wrong sibling';",
  );
  await writeFile(
    join(modules, "node-pty/package.json"),
    '{"name":"node-pty","version":"1.1.0"}',
  );
  const spawnHelper = join(
    modules,
    "node-pty/prebuilds",
    `${process.platform}-${process.arch}`,
    "spawn-helper",
  );
  await writeFile(spawnHelper, "helper");
  await chmod(spawnHelper, 0o755);
  const dependencies = [
    {
      path: "node_modules/dependency",
      name: "dependency",
      version: "1.0.0",
      integrity: "sha512-dependency",
    },
    {
      path: "node_modules/node-pty",
      name: "node-pty",
      version: "1.1.0",
      integrity: "sha512-node-pty",
    },
  ];
  const shrinkwrap = JSON.stringify({
    packages: Object.fromEntries(
      dependencies.map((item) => [
        item.path,
        { version: item.version, integrity: item.integrity },
      ]),
    ),
  });
  await writeFile(join(packageRoot, "npm-shrinkwrap.json"), shrinkwrap);
  await writeFile(join(packageRoot, "release-shrinkwrap.json"), shrinkwrap);
  async function writeManifest(extra: Record<string, unknown> = {}) {
    const files: Array<{
      path: string;
      bytes: number;
      sha256: string;
      executable: boolean;
    }> = [];
    async function inventory(path: string) {
      const absolute = join(packageRoot, path);
      const info = await lstat(absolute);
      if (info.isDirectory()) {
        for (const entry of (await readdir(absolute)).sort())
          await inventory(path ? `${path}/${entry}` : entry);
        return;
      }
      if (!info.isFile()) throw new Error(`invalid fixture file ${path}`);
      if (path === "release-manifest.json") return;
      const bytes = await readFile(absolute);
      files.push({
        path,
        bytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        executable: (info.mode & 0o111) !== 0,
      });
    }
    for (const path of payloadPaths) await inventory(path);
    await inventory("node_modules");
    await writeFile(
      join(packageRoot, "release-manifest.json"),
      JSON.stringify({
        schema: 1,
        product: "suri-pi",
        productVersion: "0.1.0",
        dependencies,
        files,
        ...extra,
      }) + "\n",
    );
  }
  await writeManifest();
  return {
    root,
    project,
    modules,
    packageRoot,
    dataRoot: join(root, "data"),
    writeManifest,
  };
}

function activePath(item: { dataRoot: string }) {
  return join(item.dataRoot, "releases/active.json");
}

describe("immutable Local releases", () => {
  test("stages only the manifest dependency closure and revalidates reuse", async () => {
    const item = await fixture();
    const first = await prepareLocalRelease(item);
    const second = await prepareLocalRelease(item);
    expect(second.root).toBe(first.root);
    expect(
      await readFile(
        join(first.root, "node_modules/dependency/index.js"),
        "utf8",
      ),
    ).toContain("module.exports");
    await expect(
      readFile(join(first.root, "node_modules/unrelated-sibling/package.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(
      (
        await stat(
          join(
            first.root,
            "node_modules/node-pty/prebuilds",
            `${process.platform}-${process.arch}`,
            "spawn-helper",
          ),
        )
      ).mode & 0o111,
    ).not.toBe(0);
  });

  test("fails closed when the release manifest is missing", async () => {
    const item = await fixture();
    await rm(join(item.packageRoot, "release-manifest.json"));
    await expect(prepareLocalRelease(item)).rejects.toThrow(
      "RELEASE_MANIFEST_MISSING",
    );
  });

  test("binds dependency bytes to their exact bundled lock path", async () => {
    const item = await fixture();
    await writeFile(
      join(item.modules, "dependency/index.js"),
      "module.exports = 'tampered';",
    );
    await expect(prepareLocalRelease(item)).rejects.toThrow(
      "RELEASE_CONTENT_MISMATCH",
    );
    await expect(readFile(activePath(item))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  test("rejects changed payload under an unchanged manifest before activation", async () => {
    const item = await fixture();
    await writeFile(join(item.packageRoot, "dist/ui/index.html"), "tampered");
    await expect(prepareLocalRelease(item)).rejects.toThrow(
      "RELEASE_CONTENT_MISMATCH",
    );
    await expect(readFile(activePath(item))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  test("does not trust a ready marker when staged content is damaged", async () => {
    const item = await fixture();
    const release = await prepareLocalRelease(item);
    await writeFile(join(release.root, "dist/ui/index.html"), "damaged");
    await expect(prepareLocalRelease(item)).rejects.toThrow(
      "RELEASE_INTEGRITY_FAILED",
    );
  });

  test("rejects symlinks in package and dependency trees without copying targets", async () => {
    const packageItem = await fixture();
    await symlink("/tmp", join(packageItem.packageRoot, "escape"));
    await expect(prepareLocalRelease(packageItem)).rejects.toThrow(
      "RELEASE_SYMLINK_DENIED",
    );
    const dependencyItem = await fixture();
    await symlink("/tmp", join(dependencyItem.modules, "dependency/escape"));
    await expect(prepareLocalRelease(dependencyItem)).rejects.toThrow(
      "RELEASE_SYMLINK_DENIED",
    );
  });

  test("atomically activates concurrent staging and preserves valid rollback", async () => {
    const item = await fixture();
    const [a, b] = await Promise.all([
      prepareLocalRelease(item),
      prepareLocalRelease(item),
    ]);
    expect(a.root).toBe(b.root);
    await item.writeManifest({ generation: 2 });
    const second = await prepareLocalRelease(item);
    const marker = JSON.parse(await readFile(activePath(item), "utf8"));
    expect(marker).toEqual({
      release: second.root.split("/").at(-1),
      previous: a.root.split("/").at(-1),
    });
    expect((await rollbackLocalRelease(item.dataRoot)).root).toBe(a.root);
  });

  test("rejects invalid marker names and release symlink targets without mutation", async () => {
    const item = await fixture();
    const release = await prepareLocalRelease(item);
    const before = await readFile(activePath(item), "utf8");
    await writeFile(
      activePath(item),
      JSON.stringify({
        release: release.root.split("/").at(-1),
        previous: "../escape",
      }),
    );
    const invalid = await readFile(activePath(item), "utf8");
    await expect(rollbackLocalRelease(item.dataRoot)).rejects.toThrow(
      "RELEASE_ACTIVE_MARKER_INVALID",
    );
    expect(await readFile(activePath(item), "utf8")).toBe(invalid);
    await writeFile(activePath(item), before);
    await symlink(
      "/tmp",
      join(item.dataRoot, "releases", "0.1.0-aaaaaaaaaaaaaaaa"),
    );
    await writeFile(
      activePath(item),
      JSON.stringify({
        release: release.root.split("/").at(-1),
        previous: "0.1.0-aaaaaaaaaaaaaaaa",
      }),
    );
    const symlinkMarker = await readFile(activePath(item), "utf8");
    await expect(rollbackLocalRelease(item.dataRoot)).rejects.toThrow(
      "RELEASE_TARGET_INVALID",
    );
    expect(await readFile(activePath(item), "utf8")).toBe(symlinkMarker);
  });

  test("does not activate a damaged previous release", async () => {
    const item = await fixture();
    const first = await prepareLocalRelease(item);
    await item.writeManifest({ generation: 2 });
    await prepareLocalRelease(item);
    await writeFile(join(first.root, "bin/suri"), "damaged");
    const before = await readFile(activePath(item), "utf8");
    await expect(rollbackLocalRelease(item.dataRoot)).rejects.toThrow(
      "RELEASE_INTEGRITY_FAILED",
    );
    expect(await readFile(activePath(item), "utf8")).toBe(before);
  });

  test("failed staging leaves the existing active release unchanged", async () => {
    const item = await fixture();
    await prepareLocalRelease(item);
    const before = await readFile(activePath(item), "utf8");
    await item.writeManifest({ generation: 2 });
    await rm(join(item.modules, "dependency/index.js"));
    await symlink("/tmp", join(item.modules, "dependency/escape"));
    await expect(prepareLocalRelease(item)).rejects.toThrow(
      "RELEASE_SYMLINK_DENIED",
    );
    expect(await readFile(activePath(item), "utf8")).toBe(before);
  });
});
