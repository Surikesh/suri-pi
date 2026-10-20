import { it, expect } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Storage } from "../../apps/host/src/storage.js";
import { schemaSql } from "../../apps/host/src/storage-schema.js";
it("journals dedupe before dispatch and rejects changed payloads", () => {
  const dir = mkdtempSync(join(tmpdir(), "suri-store-"));
  const db = new Storage(dir);
  try {
    const c = {
      v: 1 as const,
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      type: "run.submit",
      payload: { text: "synthetic" },
    };
    expect(db.reserve(c)).toBeUndefined();
    expect(db.reserve(c)?.status).toBe("accepted");
    expect(() => db.reserve({ ...c, payload: { text: "different" } })).toThrow(
      "reused",
    );
    db.close();
    const recovered = new Storage(dir);
    expect(recovered.reserve(c)?.status).toBe("indeterminate");
    recovered.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
it("pages transcript history backward without overlapping the live projection", () => {
  const dir = mkdtempSync(join(tmpdir(), "suri-store-"));
  const db = new Storage(dir);
  try {
    for (let index = 1; index <= 205; index++)
      db.event("session:test", "message.upsert", {
        messageId: `message-${index}`,
        role: "user",
        blocks: [{ type: "text", text: `Message ${index}` }],
        revision: 1,
        final: true,
      });
    const first = db.history("session:test", undefined, 200);
    expect(first.messages).toHaveLength(200);
    expect(first.messages[0].messageId).toBe("message-6");
    expect(first.cursor).not.toBeNull();
    const second = db.history("session:test", first.cursor ?? undefined, 100);
    expect(second.messages.map((message) => message.messageId)).toEqual([
      "message-1",
      "message-2",
      "message-3",
      "message-4",
      "message-5",
    ]);
    expect(second.cursor).toBeNull();
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

it("commits event and projection together and keeps seq across restarts", () => {
  const dir = mkdtempSync(join(tmpdir(), "suri-store-"));
  let db = new Storage(dir);
  try {
    db.event("session:test", "run.state", { phase: "running" });
    expect(db.snapshot("session:test").seq).toBe(1);
    db.close();
    db = new Storage(dir);
    expect(db.event("session:test", "run.state", { phase: "idle" }).seq).toBe(
      2,
    );
    expect(db.replay("session:test", 0)).toHaveLength(2);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

const asyncCommand = (type = "session.resume") => ({
  v: 1 as const,
  id: randomUUID(),
  createdAt: new Date().toISOString(),
  type,
  payload: {},
});
const resultEvents = (db: Storage, stream: string) =>
  db.replay(stream, 0).filter((event) => event.type === "command.result");

it("async recovery commits rejection and result event atomically", () => {
  const dir = mkdtempSync(join(tmpdir(), "suri-store-"));
  let db = new Storage(dir);
  const marked = asyncCommand();
  const done = asyncCommand();
  const unmarked = asyncCommand("fixture.send");
  const catalog = asyncCommand("runtime.validate");
  try {
    for (const c of [marked, done, unmarked, catalog]) db.reserve(c);
    db.markAsync(marked.id, "session:s1");
    db.markAsync(done.id, "session:s1");
    db.markAsync(catalog.id, "catalog");
    db.receipt({ v: 1, id: done.id, status: "completed", result: { ok: 1 } });
    db.close();

    // Fault at the event write: an event row already owns the next sequence.
    const raw = new Database(join(dir, "state.sqlite"));
    raw
      .prepare("INSERT INTO events VALUES('session:s1',1,'blocker','{}','x')")
      .run();
    raw.close();
    expect(() => new Storage(dir)).toThrow();
    const check = new Database(join(dir, "state.sqlite"));
    expect(
      check.prepare("SELECT id,status FROM commands ORDER BY created_at").all(),
    ).toHaveLength(4);
    expect(
      check
        .prepare("SELECT status FROM commands WHERE id IN (?,?,?)")
        .all(marked.id, unmarked.id, catalog.id),
    ).toEqual([
      { status: "accepted" },
      { status: "accepted" },
      { status: "accepted" },
    ]);
    expect(check.prepare("SELECT count(*) AS n FROM events").get()).toEqual({
      n: 1,
    });
    check.prepare("DELETE FROM events").run();
    check.close();

    // Restored: exactly one rejection and one result event per marked stream.
    db = new Storage(dir);
    const interrupted = {
      v: 1,
      status: "rejected",
      error: {
        code: "ASYNC_INTERRUPTED",
        message:
          "The accepted operation was interrupted before its completion was saved.",
        retryable: false,
      },
    };
    expect(db.commandReceipt(marked.id)).toEqual({
      ...interrupted,
      id: marked.id,
    });
    expect(db.commandReceipt(catalog.id)).toEqual({
      ...interrupted,
      id: catalog.id,
    });
    expect(resultEvents(db, "session:s1").map((e) => e.payload)).toEqual([
      { ...interrupted, id: marked.id },
    ]);
    expect(resultEvents(db, "catalog").map((e) => e.payload)).toEqual([
      { ...interrupted, id: catalog.id },
    ]);
    expect(db.commandReceipt(done.id)).toMatchObject({ status: "completed" });
    // Unmarked accepted stays indeterminate and gets no event.
    expect(db.reserve(unmarked)?.status).toBe("indeterminate");
    db.close();

    // A second restart neither duplicates nor changes anything.
    db = new Storage(dir);
    expect(resultEvents(db, "session:s1")).toHaveLength(1);
    expect(resultEvents(db, "catalog")).toHaveLength(1);
    expect(db.head("session:s1")).toBe(1);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// The exact c104d7e Storage statements (git show c104d7e:apps/host/src/storage.ts).
const oldHost = (path: string) => {
  const db = new Database(path);
  return {
    startup: () =>
      db
        .prepare(
          "UPDATE commands SET status='indeterminate',result_json=json_set(result_json,'$.status','indeterminate') WHERE status='accepted'",
        )
        .run(),
    reserve: (id: string) => {
      const found = db.prepare("SELECT * FROM commands WHERE id=?").get(id);
      db.prepare("INSERT INTO commands VALUES(?,?,?,?,?)").run(
        id,
        "hash",
        "accepted",
        JSON.stringify({ v: 1, id, status: "accepted" }),
        new Date().toISOString(),
      );
      return found;
    },
    settle: (id: string) =>
      db
        .prepare("UPDATE commands SET status=?,result_json=? WHERE id=?")
        .run(
          "completed",
          JSON.stringify({ v: 1, id, status: "completed" }),
          id,
        ),
    status: (id: string) =>
      (
        db.prepare("SELECT status FROM commands WHERE id=?").get(id) as
          { status: string } | undefined
      )?.status,
    close: () => db.close(),
  };
};
const commandColumns = (path: string) => {
  const db = new Database(path);
  const columns = (db.pragma("table_info(commands)") as { name: string }[]).map(
    (c) => c.name,
  );
  const version = db.pragma("user_version", { simple: true });
  db.close();
  return { columns, version };
};
const preShape = {
  columns: ["id", "payload_hash", "status", "result_json", "created_at"],
  version: 1,
};

it("pre-F7e host statements keep working on fresh and migrated F7e databases", () => {
  const fresh = mkdtempSync(join(tmpdir(), "suri-store-"));
  const legacy = mkdtempSync(join(tmpdir(), "suri-store-"));
  try {
    // (a) fresh F7e database: commands keeps its pre-F7e shape.
    new Storage(fresh).close();
    const freshPath = join(fresh, "state.sqlite");
    expect(commandColumns(freshPath)).toEqual(preShape);
    const a = oldHost(freshPath);
    const idA = randomUUID();
    expect(a.reserve(idA)).toBeUndefined();
    a.settle(idA);
    expect(a.status(idA)).toBe("completed");
    a.startup();
    a.close();

    // (b) pre-F7e database (no marker table) opened once by F7e.
    const legacyPath = join(legacy, "state.sqlite");
    const raw = new Database(legacyPath);
    raw.exec(
      schemaSql.replace(
        / CREATE TABLE IF NOT EXISTS async_completions[^\n]*\n/,
        "",
      ),
    );
    expect(
      raw
        .prepare("SELECT 1 FROM sqlite_master WHERE name='async_completions'")
        .get(),
    ).toBeUndefined();
    raw.close();
    const pre = oldHost(legacyPath);
    const kept = randomUUID();
    pre.reserve(kept);
    pre.close();
    new Storage(legacy).close();
    expect(commandColumns(legacyPath)).toEqual(preShape);
    const b = oldHost(legacyPath);
    expect(b.status(kept)).toBe("indeterminate");
    const idB = randomUUID();
    expect(b.reserve(idB)).toBeUndefined();
    b.settle(idB);
    expect(b.status(idB)).toBe("completed");
    b.startup();
    b.close();
  } finally {
    rmSync(fresh, { recursive: true, force: true });
    rmSync(legacy, { recursive: true, force: true });
  }
});

it("marker recovery stays exactly-once across mixed old and new host restarts", () => {
  const dir = mkdtempSync(join(tmpdir(), "suri-store-"));
  const path = join(dir, "state.sqlite");
  try {
    let db = new Storage(dir);
    const demoted = asyncCommand();
    const stranded = asyncCommand();
    const settled = asyncCommand();
    for (const c of [demoted, stranded, settled]) {
      db.reserve(c);
      db.markAsync(c.id, "session:s1");
    }
    db.receipt({ v: 1, id: settled.id, status: "completed", result: {} });
    // Terminal settlement removed its marker in the same write.
    const markers = () => {
      const raw = new Database(path);
      const ids = (
        raw.prepare("SELECT command_id FROM async_completions").all() as {
          command_id: string;
        }[]
      )
        .map((r) => r.command_id)
        .sort();
      raw.close();
      return ids;
    };
    expect(markers()).toEqual([demoted.id, stranded.id].sort());
    db.close();

    // An older host restarts first and demotes every accepted receipt; a
    // marker whose command row is gone is also left behind.
    const old = oldHost(path);
    old.startup();
    old.close();
    const raw = new Database(path);
    raw
      .prepare("INSERT INTO async_completions VALUES(?,?)")
      .run(randomUUID(), "catalog");
    raw.close();
    db = new Storage(dir);
    expect(db.commandReceipt(demoted.id)?.status).toBe("indeterminate");
    expect(db.commandReceipt(stranded.id)?.status).toBe("indeterminate");
    expect(resultEvents(db, "session:s1")).toHaveLength(0);
    expect(resultEvents(db, "catalog")).toHaveLength(0);
    expect(markers()).toEqual([]);

    // A new accepted marked command is recovered once, never again.
    const fresh = asyncCommand();
    db.reserve(fresh);
    db.markAsync(fresh.id, "session:s1");
    db.close();
    for (let restart = 0; restart < 2; restart++) {
      db = new Storage(dir);
      expect(db.commandReceipt(fresh.id)?.error?.code).toBe(
        "ASYNC_INTERRUPTED",
      );
      expect(resultEvents(db, "session:s1").map((e) => e.payload.id)).toEqual([
        fresh.id,
      ]);
      expect(markers()).toEqual([]);
      db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
