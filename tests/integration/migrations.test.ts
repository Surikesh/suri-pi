import { it, expect } from "vitest";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Storage } from "../../apps/host/src/storage.js";
import { migrate } from "../../apps/host/src/migrations.js";
it("v1 to v2 backs up, preserves identity/preferences, and refuses downgrade", async () => {
  const root = await mkdtemp(join(tmpdir(), "suri-migrate-"));
  const store = new Storage(root);
  store.put("preferences", {
    id: "preferences",
    revision: 4,
    values: { sidebarWidth: 241, icon: "fixture", unknownFutureKey: "keep" },
  });
  const before = JSON.stringify(store.list("preferences"));
  try {
    await migrate(store.db, 2, join(root, "backup.sqlite"), (db) =>
      db.exec(
        "CREATE TABLE v2_fixture_defaults(key TEXT PRIMARY KEY, value TEXT)",
      ),
    );
    expect((await stat(join(root, "backup.sqlite"))).size).toBeGreaterThan(0);
    expect(JSON.stringify(store.list("preferences"))).toBe(before);
    expect(store.db.pragma("user_version", { simple: true })).toBe(2);
    await expect(
      migrate(store.db, 1, join(root, "bad.sqlite"), () => {}),
    ).rejects.toThrow("downgraded");
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
it("failed migration rolls back and retains the usable backup", async () => {
  const root = await mkdtemp(join(tmpdir(), "suri-migrate-"));
  const store = new Storage(root);
  try {
    await expect(
      migrate(store.db, 2, join(root, "backup.sqlite"), (db) => {
        db.exec("CREATE TABLE interrupted_fixture(id TEXT)");
        throw Error("synthetic crash");
      }),
    ).rejects.toThrow("synthetic crash");
    expect(store.db.pragma("user_version", { simple: true })).toBe(1);
    expect(
      store.db
        .prepare(
          "SELECT name FROM sqlite_master WHERE name='interrupted_fixture'",
        )
        .get(),
    ).toBeUndefined();
    expect((await stat(join(root, "backup.sqlite"))).size).toBeGreaterThan(0);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
