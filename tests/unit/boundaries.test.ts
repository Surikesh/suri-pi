import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
// The production checker is intentionally plain ESM so it can run before TypeScript builds.
import {
  analyzeBoundaries,
  importedSpecifiers,
} from "../../scripts/boundaries-lib.mjs";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function fixture(files: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), "suri-boundaries-"));
  roots.push(root);
  for (const [path, content] of Object.entries(files)) {
    const target = join(root, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
  }
  return root;
}

describe("boundary analysis", () => {
  test("finds static, dynamic, and require imports through TypeScript preprocessing", () => {
    expect(
      importedSpecifiers('import x from "./a"; import("./b"); require("./c")'),
    ).toEqual(expect.arrayContaining(["./a", "./b", "./c"]));
  });

  test("permits an acyclic public feature entrypoint", async () => {
    const root = await fixture({
      "features/a/view.ts":
        'import { value } from "../b/index"; export const result = value;',
      "features/b/index.ts": "export const value = 1;",
    });
    expect(await analyzeBoundaries([root])).toEqual([]);
  });

  test("rejects cycles and private cross-feature imports", async () => {
    const root = await fixture({
      "features/a/view.ts": 'import "../b/private";',
      "features/b/private.ts": 'import "../a/view";',
    });
    const violations = await analyzeBoundaries([root]);
    expect(
      violations.some((value) => value.includes("private feature import")),
    ).toBe(true);
    expect(violations.some((value) => value.includes("import cycle"))).toBe(
      true,
    );
  });
});
