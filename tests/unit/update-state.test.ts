import { describe, expect, it } from "vitest";
import {
  mkdtemp,
  mkdir,
  rm,
  readFile,
  writeFile,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UpdateStateStore } from "../../apps/host/src/update-state.js";
async function fixture(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "suri-update-state-"));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
describe("durable update state", () => {
  it("stops mutations after a failed atomic commit without promoting in-memory state", async () =>
    fixture(async (root) => {
      const store = await UpdateStateStore.load(root);
      await rm(join(root, "updates/state.json"));
      await mkdir(join(root, "updates/state.json"));
      await expect(
        store.change(0, (state) => {
          state.activeUiId = "a".repeat(64);
        }),
      ).rejects.toMatchObject({ code: "STORAGE_UNAVAILABLE" });
      expect(store.snapshot().activeUiId).toBeNull();
      await expect(store.change(0, () => {})).rejects.toMatchObject({
        code: "STORAGE_UNAVAILABLE",
      });
    }));
  it("retains revisions, independent fallback and a complete backup", async () =>
    fixture(async (root) => {
      const store = await UpdateStateStore.load(root);
      const initial = store.snapshot();
      const next = await store.change(0, (state) => {
        state.activeUiId = "a".repeat(64);
        state.packagedFallbackUiId = "b".repeat(64);
      });
      expect((await UpdateStateStore.load(root)).snapshot()).toEqual(next);
      expect(
        JSON.parse(
          await readFile(join(root, "updates/state.previous.json"), "utf8"),
        ),
      ).toEqual(initial);
      expect((await stat(join(root, "updates/state.json"))).mode & 0o777).toBe(
        0o600,
      );
      expect((await stat(join(root, "updates"))).mode & 0o777).toBe(0o700);
    }));
  it("one concurrent revision wins; failed mutations do not poison the queue", async () =>
    fixture(async (root) => {
      const store = await UpdateStateStore.load(root);
      const outcomes = await Promise.allSettled([
        store.change(0, (state) => {
          state.channel = "development";
        }),
        store.change(0, () => {}),
      ]);
      expect(outcomes.map((outcome) => outcome.status)).toEqual([
        "fulfilled",
        "rejected",
      ]);
      await expect(
        store.change(1, () => {
          throw Error("fixture");
        }),
      ).rejects.toThrow("fixture");
      expect((await store.change(1, () => {})).revision).toBe(2);
    }));
  it("corrupt primary never silently resets or promotes the backup", async () =>
    fixture(async (root) => {
      const store = await UpdateStateStore.load(root);
      await store.change(0, () => {});
      await writeFile(join(root, "updates/state.json"), "broken");
      await expect(UpdateStateStore.load(root)).rejects.toMatchObject({
        code: "UPDATE_STATE_CORRUPT",
      });
      await rm(join(root, "updates/state.json"));
      await expect(UpdateStateStore.load(root)).rejects.toMatchObject({
        code: "UPDATE_STATE_CORRUPT",
      });
    }));
});
