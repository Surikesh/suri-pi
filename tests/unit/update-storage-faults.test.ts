import { expect, test, vi } from "vitest";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { UpdateStateStore } from "../../apps/host/src/update-state.js";

const fault = vi.hoisted(() => ({ target: "", stage: "" }));
vi.mock("node:fs/promises", async (original) => {
  const real = await original<typeof import("node:fs/promises")>();
  const fail = () => {
    throw Object.assign(new Error("injected storage fault"), {
      code: fault.stage === "write" ? "ENOSPC" : "EIO",
    });
  };
  return {
    ...real,
    open: async (...args: Parameters<typeof real.open>) => {
      const handle = await real.open(...args);
      if (!fault.target || !String(args[0]).startsWith(fault.target + ".tmp-"))
        return handle;
      return new Proxy(handle, {
        get(target, key) {
          if (key === "writeFile" && fault.stage === "write")
            return async (bytes: string) => {
              await target.writeFile(bytes.slice(0, 32));
              fail();
            };
          if (key === "sync" && fault.stage === "sync")
            return async () => fail();
          const value = Reflect.get(target, key, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    },
    rename: async (...args: Parameters<typeof real.rename>) => {
      if (String(args[1]) === fault.target && fault.stage === "rename") fail();
      return real.rename(...args);
    },
  };
});

test.each(["write", "sync", "rename"])(
  "%s failure preserves complete last-good state and closes mutation admission",
  async (stage) => {
    const root = await mkdtemp(join(tmpdir(), "suri-storage-fault-"));
    try {
      const store = await UpdateStateStore.load(root);
      const before = await store.change(0, (state) => {
        state.activeUiId = "a".repeat(64);
        state.knownGood = [state.activeUiId];
      });
      fault.target = join(root, "updates/state.json");
      fault.stage = stage;
      await expect(
        store.change(before.revision, (state) => {
          state.activeUiId = "b".repeat(64);
        }),
      ).rejects.toMatchObject({ code: "STORAGE_UNAVAILABLE" });
      expect(store.snapshot()).toEqual(before);
      expect(JSON.parse(await readFile(fault.target, "utf8"))).toEqual(before);
      expect(
        JSON.parse(
          await readFile(join(root, "updates/state.previous.json"), "utf8"),
        ),
      ).toEqual(before);
      expect(
        (await readdir(join(root, "updates"))).some((name) =>
          name.includes(".tmp-"),
        ),
      ).toBe(false);
      await expect(
        store.change(before.revision, () => {}),
      ).rejects.toMatchObject({ code: "STORAGE_UNAVAILABLE" });
      expect((await UpdateStateStore.load(root)).snapshot()).toEqual(before);
    } finally {
      fault.target = "";
      fault.stage = "";
      await rm(root, { recursive: true, force: true });
    }
  },
);
