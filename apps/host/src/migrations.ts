import type Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { SuriError } from "../../../packages/protocol/src/index.js";
export async function migrate(
  db: Database.Database,
  target: number,
  backupPath: string,
  apply: (db: Database.Database) => void,
  active = false,
) {
  const current = db.pragma("user_version", { simple: true }) as number;
  if (current > target)
    throw new SuriError(
      "STORAGE_UNAVAILABLE",
      "Newer schema cannot be downgraded.",
    );
  if (current === target) return;
  if (active) throw new SuriError("BUSY", "Migrations require idle startup.");
  await db.backup(backupPath);
  db.transaction(() => {
    apply(db);
    db.pragma(`user_version = ${target}`);
    const integrity = db.pragma("integrity_check", { simple: true });
    if (integrity !== "ok")
      throw new SuriError("STORAGE_UNAVAILABLE", "Migration integrity failed.");
    db.prepare("INSERT INTO schema_migrations VALUES(?,?,?)").run(
      target,
      createHash("sha256").update(`suri-schema-${target}`).digest("hex"),
      new Date().toISOString(),
    );
  })();
}
