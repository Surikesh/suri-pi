import { describe, it, expect } from "vitest";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  canonicalJson,
  UiIdentitySchema,
  UpdatePathSchema,
  CompatibilitySchema,
  InventorySchema,
} from "../../packages/protocol/src/updates.js";
import {
  inventory,
  publishArtifact,
  updateCompatibility,
  digest,
} from "../../scripts/build-manifests.mjs";

async function fixture(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "suri-update-manifests-"));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
async function candidate(root: string, name: string, text = "export {}") {
  const stage = join(root, name);
  await mkdir(stage);
  await writeFile(
    join(stage, "index.html"),
    '<script type="module" src="./entry.js"></script>',
  );
  await writeFile(join(stage, "entry.js"), text);
  const identity = UiIdentitySchema.parse({
    schema: 1,
    kind: "ui",
    compatibility: updateCompatibility,
    entry: "entry.js",
    files: await inventory(stage),
  });
  return { stage, identity };
}
describe("update artifact identities", () => {
  it("rejects noncanonical paths and nonfinite/reversed compatibility", () => {
    for (const path of [
      "/x",
      "../x",
      "a/../b",
      "a//b",
      "a/./b",
      "C:x",
      "a\\b",
      "a\0b",
      "a/",
    ])
      expect(UpdatePathSchema.safeParse(path).success).toBe(false);
    for (const hostMax of [NaN, Infinity, -1, 1.5, 0])
      expect(
        CompatibilitySchema.safeParse({ ...updateCompatibility, hostMax })
          .success,
      ).toBe(false);
  });
  it("rejects duplicate, overlapping and over-limit inventories", () => {
    const file = {
      path: "a",
      bytes: 0,
      sha256: "a".repeat(64),
      executable: false,
    };
    expect(InventorySchema.safeParse([file, file]).success).toBe(false);
    expect(
      InventorySchema.safeParse([file, { ...file, path: "a/b" }]).success,
    ).toBe(false);
    expect(
      InventorySchema.safeParse([{ ...file, bytes: 64 * 1024 * 1024 + 1 }])
        .success,
    ).toBe(false);
    expect(
      InventorySchema.safeParse(
        Array.from({ length: 9 }, (_, i) => ({
          ...file,
          path: `a${i}`,
          bytes: 64 * 1024 * 1024,
        })),
      ).success,
    ).toBe(false);
  });
  it("has deterministic content IDs independent of timestamp and enumeration order", async () =>
    fixture(async (root) => {
      const a = await candidate(root, "a");
      const b = await candidate(root, "b");
      b.identity.files.reverse();
      const first = await publishArtifact(
        join(root, "published"),
        a.stage,
        a.identity,
        "2026-01-01T00:00:00.000Z",
      );
      const second = await publishArtifact(
        join(root, "published"),
        b.stage,
        b.identity,
        "2026-02-01T00:00:00.000Z",
      );
      expect(first.buildId).toBe(second.buildId);
      expect(
        JSON.parse(await readFile(join(root, "published/latest.json"), "utf8")),
      ).toEqual({ schema: 1, generation: 2, buildId: first.buildId });
      const c = await candidate(root, "c", "throw Error()");
      expect(
        (await publishArtifact(join(root, "published"), c.stage, c.identity))
          .buildId,
      ).not.toBe(first.buildId);
    }));
  it("does not publish changed/failed stage or overwrite a corrupt existing ID", async () =>
    fixture(async (root) => {
      const a = await candidate(root, "a");
      const first = await publishArtifact(
        join(root, "published"),
        a.stage,
        a.identity,
      );
      const pointer = await readFile(
        join(root, "published/latest.json"),
        "utf8",
      );
      const b = await candidate(root, "b");
      await writeFile(join(b.stage, "entry.js"), "changed");
      await expect(
        publishArtifact(join(root, "published"), b.stage, b.identity),
      ).rejects.toThrow("BUILD_CONTENT_CHANGED");
      await writeFile(join(first.path, "entry.js"), "corrupt");
      const c = await candidate(root, "c");
      await expect(
        publishArtifact(join(root, "published"), c.stage, c.identity),
      ).rejects.toThrow("BUILD_ID_COLLISION");
      expect(await readFile(join(root, "published/latest.json"), "utf8")).toBe(
        pointer,
      );
    }));
  it("refuses symlinks and publication lock contention", async () =>
    fixture(async (root) => {
      const a = await candidate(root, "a");
      await symlink(join(a.stage, "entry.js"), join(a.stage, "link"));
      await expect(inventory(a.stage)).rejects.toThrow(
        "BUILD_FILE_TYPE_INVALID",
      );
      await mkdir(join(root, "published/.publication-lock"), {
        recursive: true,
      });
      await expect(
        publishArtifact(join(root, "published"), a.stage, a.identity),
      ).rejects.toThrow("BUILD_PUBLICATION_BUSY");
    }));
  it("canonical serialization rejects unsupported values", () => {
    expect(canonicalJson({ b: 2, a: 1 })).toBe(canonicalJson({ a: 1, b: 2 }));
    expect(() => canonicalJson({ a: undefined })).toThrow();
    expect(digest("a")).not.toBe(digest("b"));
  });
});
