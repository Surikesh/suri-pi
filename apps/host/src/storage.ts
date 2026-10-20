import Database from "better-sqlite3";
import { mkdirSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { schemaSql } from "./storage-schema.js";
import {
  initialProjection,
  reduce,
  SuriError,
  activePhases,
  failure,
  type Data,
  type Event,
  type Command,
  type Receipt,
  type Projection,
} from "../../../packages/protocol/src/index.js";
export class Storage {
  readonly db: Database.Database;
  private statements = new Map<string, Database.Statement>();
  private statement(sql: string): Database.Statement {
    let statement = this.statements.get(sql);
    if (!statement) {
      statement = this.db.prepare(sql);
      this.statements.set(sql, statement);
    }
    return statement;
  }
  readonly epoch = randomUUID();
  constructor(readonly root: string) {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    chmodSync(root, 0o700);
    this.db = new Database(join(root, "state.sqlite"));
    try {
      chmodSync(join(root, "state.sqlite"), 0o600);
      const version = this.db.pragma("user_version", {
        simple: true,
      }) as number;
      if (version > 1) {
        this.db.close();
        throw new SuriError(
          "STORAGE_UNAVAILABLE",
          "This data requires a newer Suri host.",
        );
      }
      this.db.pragma("journal_mode = WAL");
      this.db.pragma("foreign_keys = ON");
      this.db.pragma("busy_timeout = 5000");
      this.db.exec(schemaSql);
      if (
        this.statement(
          "SELECT name FROM sqlite_master WHERE name='objects'",
        ).get() &&
        !this.statement("SELECT id FROM projects LIMIT 1").get()
      ) {
        const legacy = this.statement(
          "SELECT kind,json FROM objects",
        ).all() as {
          kind: string;
          json: string;
        }[];
        this.db.transaction(() => {
          for (const kind of [
            "runtime",
            "project",
            "workspace",
            "session",
            "asset",
            "preferences",
            "draft",
          ])
            for (const row of legacy.filter((r) => r.kind === kind))
              this.put(kind, JSON.parse(row.json));
        })();
      }
      this.statement(
        "INSERT OR IGNORE INTO schema_migrations VALUES(1,?,?)",
      ).run(
        createHash("sha256").update("suri-initial-objects-v1").digest("hex"),
        new Date().toISOString(),
      );
      this.recoverAccepted();
      for (const s of this.list("session")) {
        const p = this.snapshot(`session:${s.id}`);
        if (activePhases.has(p.phase))
          this.event(`session:${s.id}`, "session.state", {
            phase: "interrupted",
            outcome: "interrupted",
            reason: "HOST_RESTART",
          });
      }
    } catch (error) {
      if (this.db.open) this.db.close();
      throw error;
    }
  }
  /** One transaction: marked async receipts become ASYNC_INTERRUPTED with their result event; other accepted receipts become indeterminate. */
  private recoverAccepted() {
    this.db.transaction(() => {
      const marked = this.statement(
        "SELECT m.command_id AS id,m.stream_id AS stream FROM async_completions m JOIN commands c ON c.id=m.command_id WHERE c.status='accepted'",
      ).all() as { id: string; stream: string }[];
      for (const { id, stream } of marked)
        this.event(
          stream,
          "command.result",
          this.receipt(
            failure(
              id,
              new SuriError(
                "ASYNC_INTERRUPTED",
                "The accepted operation was interrupted before its completion was saved.",
              ),
            ),
          ),
        );
      // Leftover markers belong to commands that are missing or already settled.
      this.statement("DELETE FROM async_completions").run();
      this.statement(
        "UPDATE commands SET status='indeterminate',result_json=json_set(result_json,'$.status','indeterminate') WHERE status='accepted'",
      ).run();
    })();
  }
  /** Durable async routing marker; written before accepted work is scheduled, removed with the terminal receipt. */
  markAsync(id: string, streamId: string) {
    this.statement(
      "INSERT OR REPLACE INTO async_completions(command_id,stream_id) VALUES(?,?)",
    ).run(id, streamId);
  }
  private table(kind: string): string {
    const tables: Record<string, string> = {
      project: "projects",
      workspace: "workspaces",
      runtime: "runtimes",
      session: "sessions",
      asset: "assets",
      preferences: "preferences",
      section: "sections",
      draft: "drafts",
    };
    if (!tables[kind])
      throw new SuriError("VALIDATION", "Unknown repository entity.");
    return tables[kind];
  }
  list(kind: string): Data[] {
    return (
      this.statement(`SELECT json FROM ${this.table(kind)}`).all() as {
        json: string;
      }[]
    ).map((r) => JSON.parse(r.json));
  }
  get(kind: string, id: string): Data {
    const row = this.statement(
      `SELECT json FROM ${this.table(kind)} WHERE id=?`,
    ).get(id) as { json: string } | undefined;
    if (!row) throw new SuriError("NOT_FOUND", `${kind} was not found.`);
    return JSON.parse(row.json);
  }
  put(kind: string, item: Data) {
    const now = new Date().toISOString();
    const json = JSON.stringify(item);
    let fields: Record<string, unknown> = { id: item.id, json };
    switch (kind) {
      case "project":
        fields = {
          ...fields,
          canonical_root: item.root,
          label: item.label,
          icon_id: item.iconId ?? null,
          revision: item.revision,
          forgotten: item.forgotten ? 1 : 0,
        };
        break;
      case "workspace":
        fields = {
          ...fields,
          project_id: item.projectId,
          canonical_root: item.root,
          git_common_dir: item.gitCommonDir ?? null,
          branch: item.branch ?? null,
          revision: item.revision,
        };
        break;
      case "runtime":
        fields = {
          ...fields,
          executable_path: item.executable,
          package_version: item.version,
          artifact_identity: item.identity,
          validation_status: item.status,
          evidence_id: item.evidenceId ?? null,
          validated_at: item.validatedAt ?? null,
        };
        break;
      case "session":
        fields = {
          ...fields,
          workspace_id: item.workspaceId,
          pi_session_id: item.piSessionId ?? null,
          pi_file: item.piFile ?? null,
          parent_id: item.parentId ?? null,
          display_name: item.name,
          icon_id: item.iconId ?? null,
          archived: item.archived ? 1 : 0,
          runtime_id: item.runtimeId,
          revision: item.revision,
          created_at: item.createdAt ?? now,
          updated_at: item.updatedAt ?? now,
          last_read_seq: item.lastReadSeq ?? 0,
        };
        break;
      case "asset":
        fields = {
          ...fields,
          sha256: item.sha256,
          kind: item.kind,
          mime: item.mime,
          bytes: item.bytes,
          relative_path: item.id,
        };
        break;
      case "section":
      case "preferences":
        fields = { ...fields, revision: item.revision };
        break;
      case "draft":
        fields = {
          ...fields,
          session_id: item.sessionId,
          client_id: item.clientId,
          text: item.text,
          attachment_ids_json: JSON.stringify(item.attachmentIds ?? []),
          revision: item.revision,
        };
        break;
    }
    const names = Object.keys(fields);
    this.statement(
      `INSERT INTO ${this.table(kind)}(${names.join(",")}) VALUES(${names.map(() => "?").join(",")}) ON CONFLICT(id) DO UPDATE SET ${names
        .filter((n) => n !== "id")
        .map((n) => `${n}=excluded.${n}`)
        .join(",")}`,
    ).run(...Object.values(fields));
    return item;
  }
  patch(kind: string, id: string, revision: number | undefined, patch: Data) {
    const old = this.get(kind, id);
    if (revision !== old.revision)
      throw new SuriError(
        "CONFLICT",
        "This item changed. Refresh and try again.",
      );
    return this.put(kind, {
      ...old,
      ...patch,
      id,
      revision: old.revision + 1,
      updatedAt: new Date().toISOString(),
    });
  }
  remove(kind: string, id: string) {
    this.statement(`DELETE FROM ${this.table(kind)} WHERE id=?`).run(id);
  }
  head(stream: string): number {
    const row = this.statement(
      "SELECT seq FROM stream_heads WHERE stream_id=?",
    ).get(stream) as { seq: number } | undefined;
    return row?.seq ?? 0;
  }
  snapshot(stream: string): Projection {
    const r = this.statement(
      "SELECT payload_json FROM snapshots WHERE stream_id=?",
    ).get(stream) as { payload_json: string } | undefined;
    return r ? JSON.parse(r.payload_json) : initialProjection();
  }
  event(streamId: string, type: string, payload: Data): Event {
    return this.db.transaction(() => {
      const state = this.snapshot(streamId);
      const event: Event = {
        v: 1,
        hostEpoch: this.epoch,
        streamId,
        seq: state.seq + 1,
        type,
        at: new Date().toISOString(),
        ...(streamId.startsWith("session:")
          ? { sessionId: streamId.slice(8) }
          : {}),
        payload,
      };
      const next = reduce(state, event);
      next.messages = next.messages.slice(-100);
      if (type === "message.upsert")
        this.statement(
          "INSERT INTO messages VALUES(?,?,?,?) ON CONFLICT(stream_id,message_id) DO UPDATE SET json=excluded.json",
        ).run(streamId, payload.messageId, event.seq, JSON.stringify(payload));
      this.statement("INSERT INTO events VALUES(?,?,?,?,?)").run(
        streamId,
        event.seq,
        type,
        JSON.stringify(event),
        event.at,
      );
      this.statement(
        "INSERT INTO snapshots VALUES(?,?,?) ON CONFLICT(stream_id) DO UPDATE SET seq=excluded.seq,payload_json=excluded.payload_json",
      ).run(streamId, event.seq, JSON.stringify(next));
      this.statement(
        "INSERT INTO stream_heads VALUES(?,?) ON CONFLICT(stream_id) DO UPDATE SET seq=excluded.seq",
      ).run(streamId, event.seq);
      this.statement("DELETE FROM events WHERE stream_id=? AND seq<=?").run(
        streamId,
        event.seq - 10000,
      );
      this.statement("DELETE FROM events WHERE stream_id=? AND at<?").run(
        streamId,
        new Date(Date.now() - 86400000).toISOString(),
      );
      return event;
    })();
  }
  history(stream: string, before = Number.MAX_SAFE_INTEGER, limit = 100) {
    const pageSize = Math.min(Math.max(limit, 1), 500);
    const rows = this.statement(
      "SELECT first_seq,json FROM messages WHERE stream_id=? AND first_seq<? ORDER BY first_seq DESC LIMIT ?",
    ).all(stream, before, pageSize + 1) as {
      first_seq: number;
      json: string;
    }[];
    const page = rows.slice(0, pageSize);
    return {
      messages: page.map((r) => JSON.parse(r.json)).reverse(),
      cursor: rows.length > pageSize ? page.at(-1)!.first_seq : null,
      seq: this.snapshot(stream).seq,
    };
  }
  replay(stream: string, after: number): Event[] {
    return (
      this.statement(
        "SELECT payload_json FROM events WHERE stream_id=? AND seq>? ORDER BY seq",
      ).all(stream, after) as { payload_json: string }[]
    ).map((r) => JSON.parse(r.payload_json));
  }
  reserve(command: Command): Receipt | undefined {
    const hash = createHash("sha256")
      .update(JSON.stringify(command))
      .digest("hex");
    const old = this.statement("SELECT * FROM commands WHERE id=?").get(
      command.id,
    ) as Data | undefined;
    if (old) {
      if (old.payload_hash !== hash)
        throw new SuriError(
          "CONFLICT",
          "Request id was reused with different content.",
        );
      return JSON.parse(old.result_json);
    }
    const age = Date.now() - Date.parse(command.createdAt);
    if (age > 7 * 86400000 || age < -300000)
      throw new SuriError(
        "VALIDATION",
        "Request timestamp is outside the accepted window.",
      );
    this.statement("INSERT INTO commands VALUES(?,?,?,?,?)").run(
      command.id,
      hash,
      "accepted",
      JSON.stringify({ v: 1, id: command.id, status: "accepted" }),
      command.createdAt,
    );
    return undefined;
  }
  receipt(r: Receipt) {
    this.db.transaction(() => {
      this.statement(
        "UPDATE commands SET status=?,result_json=? WHERE id=?",
      ).run(r.status, JSON.stringify(r), r.id);
      if (r.status !== "accepted")
        this.statement("DELETE FROM async_completions WHERE command_id=?").run(
          r.id,
        );
    })();
    return r;
  }
  commandReceipt(id: string): Receipt | undefined {
    const row = this.statement(
      "SELECT result_json FROM commands WHERE id=?",
    ).get(id) as { result_json: string } | undefined;
    return row ? JSON.parse(row.result_json) : undefined;
  }
  close() {
    this.db.close();
  }
}
