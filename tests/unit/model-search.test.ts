import { describe, expect, it, vi } from "vitest";
import { ModelCatalog, searchModels } from "../../apps/web/src/model-search.js";
const models = [
  { provider: "zeta", id: "large-context", name: "Long Context" },
  { provider: "alpha", id: "fast-code", name: "Quick Coding" },
  { provider: "alpha", id: "code-fast", name: "Coding" },
];
describe("model discovery", () => {
  it("searches all indexed fields, ranks exact before prefix and fuzzy with stable ties", () => {
    expect(searchModels(models, "code").map((m) => m.id)).toEqual([
      "code-fast",
      "fast-code",
    ]);
    expect(searchModels(models, "alpha fast").map((m) => m.id)).toEqual([
      "fast-code",
      "code-fast",
    ]);
    expect(searchModels(models, "lgctx").map((m) => m.id)).toEqual([
      "large-context",
    ]);
    expect(searchModels(models, "", "zeta/large-context")[0].id).toBe(
      "large-context",
    );
  });
  it("coalesces by session, evicts LRU and ignores invalidated late writes", async () => {
    const cache = new ModelCatalog(2);
    let resolve!: (value: typeof models) => void;
    const fetch = vi.fn(
      () =>
        new Promise<typeof models>((done) => {
          resolve = done;
        }),
    );
    const a = cache.load("session:one", fetch);
    const b = cache.load("session:one", fetch);
    expect(fetch).toHaveBeenCalledTimes(1);
    cache.invalidate("session:one");
    resolve(models);
    await Promise.all([a, b]);
    expect(cache.get("session:one")).toBeUndefined();
    await cache.load("one", async () => models);
    await cache.load("two", async () => models);
    cache.get("one");
    await cache.load("three", async () => models);
    expect(cache.get("two")).toBeUndefined();
    expect(cache.get("one")).toEqual(models);
  });
  it("keeps the newer catalog when an invalidated child replies late", async () => {
    const cache = new ModelCatalog();
    let reply!: (value: typeof models) => void;
    const old = cache.load(
      "same-session",
      () =>
        new Promise((resolve) => {
          reply = resolve;
        }),
    );
    cache.invalidate("same-session");
    const current = [{ provider: "new-child", id: "current" }];
    expect(await cache.load("same-session", async () => current)).toEqual(
      current,
    );
    reply(models);
    await old;
    expect(cache.get("same-session")).toEqual(current);
  });
  it("searches beyond the first sixty entries in a large catalog", () => {
    const catalog = Array.from({ length: 10000 }, (_, index) => ({
      provider: "synthetic",
      id: `model-${index}`,
      name: `Synthetic ${index}`,
    }));
    expect(searchModels(catalog, "model-9999")[0].id).toBe("model-9999");
    expect(searchModels(catalog, "", "synthetic/model-9999")[0].id).toBe(
      "model-9999",
    );
  });
  it("does not cache failures and permits explicit retry", async () => {
    const cache = new ModelCatalog();
    await expect(
      cache.load("one", async () => {
        throw Error("boot denied");
      }),
    ).rejects.toThrow("boot denied");
    expect(cache.get("one")).toBeUndefined();
    expect(await cache.load("one", async () => models)).toEqual(models);
  });
});
