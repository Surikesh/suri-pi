# ADR-005 — Suri SQLite metadata, Pi-owned session format

Status: accepted, 2026-09-13.

Basis: Pi owns its session files; Suri needs its own atomic catalog, replay and
recovery state.

Choose single-writer SQLite via better-sqlite3 behind a Suri repository interface,
WAL transactions for normalized events/snapshot/metadata, private artifact files
and Pi-written JSONL in a distinct runtime subdirectory. Table-level v1 schema,
limits and transactional backup/migration procedure are in [architecture](../architecture.md).

Alternatives: separate JSON preference/catalog files make multi-record atomicity
and replay harder; browser localStorage cannot own host continuity; sharing Pi's
settings ties frontend preferences to runtime updates. Node's built-in SQLite is
an alternative, but its version-dependent API status adds toolchain coupling;
[inspected current docs](https://nodejs.org/api/sqlite.html) are not a claim about
Node 24 stability. Use the mature dependency interface selected here, with its
native package identity, ABI and license tracked in the lockfile and third-party notices.

Consequences: native packaging needs SQLite verification. Schema migrations only
at idle startup with backup and rollback; newer schemas fail without destructive
repair. UI preferences/icons are unchanged by Pi version switching. Pi session
migration remains Pi-owned and uses idle backup/version-specific copy if needed.
No automatic transcript export; application content is not diagnostic logging.
