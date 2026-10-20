import { test, expect, vi } from "vitest";
import { viewStorage } from "../../apps/web/src/view-storage.js";

test("draft, attachments and outbox are window-owned while legacy buffers remain intact", () => {
  const entries = new Map<string, string>([
    ["suri.draft.s", "legacy"],
    ["suri.outbox.legacy", "uncertain"],
  ]);
  const storage = {
    get length() {
      return entries.size;
    },
    key: (index: number) => [...entries.keys()][index] ?? null,
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => {
      entries.set(key, value);
    },
    removeItem: (key: string) => {
      entries.delete(key);
    },
  };
  const window = { suriUpdate: { client: "a" } };
  vi.stubGlobal("localStorage", storage);
  vi.stubGlobal("window", window);
  try {
    expect(viewStorage.getItem("suri.draft.s")).toBe("legacy");
    viewStorage.setItem("suri.draft.s", "A");
    viewStorage.setItem("suri.outbox.command-a", "owned A");
    viewStorage.setItem("suri.restored.s", "12");
    window.suriUpdate.client = "b";
    expect(viewStorage.getItem("suri.draft.s")).toBe("legacy");
    expect(viewStorage.getItem("suri.outbox.command-a")).toBeNull();
    expect(viewStorage.getItem("suri.restored.s")).toBeNull();
    expect(viewStorage.getItem("suri.outbox.legacy")).toBeNull();
    viewStorage.setItem("suri.draft.s", "B");
    window.suriUpdate.client = "a";
    expect(viewStorage.getItem("suri.draft.s")).toBe("A");
    expect(viewStorage.keys()).toContain("suri.outbox.command-a");
    expect(entries.get("suri.draft.s")).toBe("legacy");
    expect(entries.get("suri.outbox.legacy")).toBe("uncertain");
  } finally {
    vi.unstubAllGlobals();
  }
});
