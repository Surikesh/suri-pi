// Schema DDL only. `async_completions` is an additive marker table so `commands` keeps its pre-F7e shape for older hosts.
export const schemaSql = `
 CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY, checksum TEXT NOT NULL, applied_at TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY,canonical_root TEXT UNIQUE NOT NULL,label TEXT NOT NULL,icon_id TEXT,revision INTEGER NOT NULL,forgotten INTEGER NOT NULL DEFAULT 0,json TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS workspaces(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id),canonical_root TEXT UNIQUE NOT NULL,git_common_dir TEXT,branch TEXT,revision INTEGER NOT NULL,json TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS runtimes(id TEXT PRIMARY KEY,executable_path TEXT NOT NULL,package_version TEXT NOT NULL,artifact_identity TEXT NOT NULL,adapter_version INTEGER NOT NULL DEFAULT 1,validation_status TEXT NOT NULL,validated_at TEXT,evidence_id TEXT,json TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL REFERENCES workspaces(id),pi_session_id TEXT,pi_file TEXT,parent_id TEXT REFERENCES sessions(id),display_name TEXT NOT NULL,icon_id TEXT,archived INTEGER NOT NULL DEFAULT 0,runtime_id TEXT NOT NULL REFERENCES runtimes(id),revision INTEGER NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,last_read_seq INTEGER NOT NULL DEFAULT 0,json TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS assets(id TEXT PRIMARY KEY,sha256 TEXT NOT NULL,kind TEXT NOT NULL,mime TEXT NOT NULL,bytes INTEGER NOT NULL,relative_path TEXT NOT NULL,json TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS sections(id TEXT PRIMARY KEY,json TEXT NOT NULL,revision INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS preferences(id TEXT PRIMARY KEY,json TEXT NOT NULL,revision INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS drafts(id TEXT PRIMARY KEY,session_id TEXT NOT NULL REFERENCES sessions(id),client_id TEXT NOT NULL,text TEXT NOT NULL,attachment_ids_json TEXT NOT NULL,revision INTEGER NOT NULL,json TEXT NOT NULL);

 CREATE TABLE IF NOT EXISTS commands(id TEXT PRIMARY KEY,payload_hash TEXT NOT NULL,status TEXT NOT NULL,result_json TEXT NOT NULL,created_at TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS async_completions(command_id TEXT PRIMARY KEY,stream_id TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS stream_heads(stream_id TEXT PRIMARY KEY,seq INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS events(stream_id TEXT NOT NULL,seq INTEGER NOT NULL,type TEXT NOT NULL,payload_json TEXT NOT NULL,at TEXT NOT NULL,PRIMARY KEY(stream_id,seq));
 CREATE TABLE IF NOT EXISTS messages(stream_id TEXT NOT NULL,message_id TEXT NOT NULL,first_seq INTEGER NOT NULL,json TEXT NOT NULL,PRIMARY KEY(stream_id,message_id));
 CREATE INDEX IF NOT EXISTS event_retention ON events(stream_id,at);
 CREATE INDEX IF NOT EXISTS message_paging ON messages(stream_id,first_seq);
 CREATE TABLE IF NOT EXISTS snapshots(stream_id TEXT PRIMARY KEY,seq INTEGER NOT NULL,payload_json TEXT NOT NULL);
 PRAGMA user_version=1;`;
