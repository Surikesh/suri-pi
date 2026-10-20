import { expect, it, vi } from "vitest";
import { createScrollPositionWriter } from "../../apps/web/src/scroll-position.js";

it("a pending position from the previous session cannot write after a rapid switch", () => {
  vi.useFakeTimers();
  const values = new Map<string, string>();
  let selected = "first";
  const writer = createScrollPositionWriter(() => selected, {
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  });
  writer.save("first", 420, false);
  selected = "second";
  writer.save("second", 180, false);
  vi.runAllTimers();
  expect(values.get("suri.scroll.first")).toBeUndefined();
  expect(values.get("suri.scroll.second")).toBe("180");
  writer.cancel();
  vi.useRealTimers();
});
