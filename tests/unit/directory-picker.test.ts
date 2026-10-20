import { afterEach, expect, test } from "vitest";
import {
  mkdtemp,
  mkdir,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DirectoryPicker } from "../../apps/host/src/directory-picker.js";

let root: string;
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});
test("directory selection is client-bound, single-use and exposes no file contents", async () => {
  root = await mkdtemp(join(tmpdir(), "suri-picker-"));
  await mkdir(join(root, "Project"));
  await writeFile(join(root, "private.txt"), "must not be returned");
  const picker = new DirectoryPicker();
  const listing = await picker.list("owner", root);
  expect(listing.entries.map((e) => e.name)).toEqual(["Project"]);
  await expect(picker.consume("other", listing.selectionId)).rejects.toThrow(
    "Choose the folder again",
  );
  expect(await picker.consume("owner", listing.selectionId)).toBe(listing.path);
  await expect(picker.consume("owner", listing.selectionId)).rejects.toThrow(
    "Choose the folder again",
  );
  await expect(picker.list("owner", join(root, "private.txt"))).rejects.toThrow(
    "unavailable",
  );
});
test("creates a missing direct child and returns a usable selection", async () => {
  root = await mkdtemp(join(tmpdir(), "suri-picker-"));
  const picker = new DirectoryPicker();
  const folder = join(root, "New Project");
  const listing = await picker.create("owner", folder);
  const resolved = await realpath(folder);
  expect(listing.path).toBe(resolved);
  expect(listing.entries).toEqual([]);
  expect(await picker.consume("owner", listing.selectionId)).toBe(resolved);
  await expect(
    picker.create("owner", join(root, "missing", "nested")),
  ).rejects.toThrow("could not be created");
});

test("replaced directories and symlink substitutions cannot reuse a selection", async () => {
  root = await mkdtemp(join(tmpdir(), "suri-picker-"));
  const folder = join(root, "Project");
  await mkdir(folder);
  const picker = new DirectoryPicker();
  const listing = await picker.list("owner", folder);
  await rename(folder, join(root, "Previous"));
  await symlink(join(root, "Previous"), folder);
  await expect(picker.consume("owner", listing.selectionId)).rejects.toThrow(
    "changed",
  );
});
