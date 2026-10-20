# Resolved architecture and Suri Protocol v1

Status: design record for the v0.1 preview. Parts are described in the future tense
because they were written before implementation; the code and the cited tests are
authoritative where they differ. Limits below are Suri design decisions, not upstream
guarantees. Decision rationale is in [docs/adr/](adr/); owners and invariants are in
[module ownership](module-ownership.md).

## Components and dependency direction

```text
SwiftUI/WKWebView shell OR same-origin browser
                    |
             Suri React frontend
                    |
        Suri Protocol v1 (HTTP + WebSocket)
                    |
 Suri Node host: catalog / reducer / replay / files / Git / PTY
                    |
           Suri Pi adapter (JSONL)
                    |
       one public Pi RPC subprocess per live session
```

One Node 24 LTS host serves built assets, commands and streams. This avoids an
extra daemon-to-web hop while keeping ownership of sessions separate
from the window. Host is detached from the shell and survives window close and
app quit. No launchd installation, global service registration or automatic
login startup in v1. On next open, shell attaches to an existing host or starts
one if absent. It does not update/restart a host with active work. Host crashes,
OS logout and reboot interrupt runs; persistent history can be resumed explicitly.

npm workspace ownership:

| Directory                                          | Responsibility                                                    | Forbidden dependencies              |
| -------------------------------------------------- | ----------------------------------------------------------------- | ----------------------------------- |
| `packages/protocol`                                | Runtime schemas, wire types, stable codes                         | Pi types                            |
| `packages/pi-adapter`                              | Version probe, LF decoder, command mapping, Pi→Suri translation   | UI dependencies, credential readers |
| `apps/host`                                        | Child supervision, HTTP/WS, persistence, workspace/files/Git/PTY  | Pi SDK imports                      |
| `apps/web`                                         | React/Vite, normalized state, CSS tokens, rendering               | Filesystem/Node/Pi imports          |
| `apps/macos`                                       | Swift package, WKWebView lifecycle, native picker, host bootstrap | Arbitrary JS-to-shell execution     |
| `tests/fixtures`, `tests/integration`, `tests/e2e` | Synthetic contracts and disposable journeys                       | Private transcripts/credentials     |

React uses a Suri reducer/store with stable immutable snapshots and selective
subscriptions; `useSyncExternalStore` joins streaming state. Local editor/popover
state stays local. CSS variables express independently implemented visual rules;
no large themed component kit. Markdown uses react-markdown + remark-gfm without
raw HTML; highlighting via Shiki, terminal via xterm and node-pty. All exact npm
versions, engines, native ABI and licenses are resolved and locked in `package-lock.json`
and not silently refreshed. SQLite uses better-sqlite3 behind a
Suri repository interface; its native build is covered by packaging validation.

## Develop the interface from its own session

Required v1 workflow: explicitly associate a trusted Suri source checkout, open it
as an ordinary project, let Pi edit frontend modules there, run the fixed local
`npm run build:ui`, then click **Reload UI**. Pi edits source using its ordinary
tools; the file-preview API remains read-only. No plugin system or arbitrary code
execution bridge is needed. Organize frontend features into sidebar, conversation,
composer, details and settings modules, depending on shared Suri state/design
primitives rather than importing one another's internal state.

`build:ui` builds only frontend assets into a new immutable candidate directory;
it must not overwrite served files, restart the host, migrate DB or replace the
installed .app. A manifest records build id, asset hashes, protocol major and
minimum/maximum compatible host UI-contract version. Publish the candidate only
after successful build and static contract checks. Host imports assets only from
the explicitly associated checkout's fixed build-output directory into its private
UI-build store; validate paths/no symlinks and hashes. This developer association
is explicit local trust, never inferred from a transcript or ordinary project.

Selection authority is now specified by the
unified update contract: one host-owned
active UI per profile, explicit initiating-client trial and readiness promotion,
and a visible reload offer (never forced navigation) in other windows. Loaded UI,
active UI, available host and launch-snapshotted running host are separate identities.
Ordinary refresh follows active; pinning is explicit and visible. Build/import,
activation, host restart and native replacement are distinct transitions.

Two update paths exist. The legacy path is the default. `ui.activate {buildId}` there
remains import/URL-only, not global activation permission, and the read-only
`updates.get` reports `updates-status-v1` with `activationSupported: false`. Legacy
launches report unknown host build identity rather than hashing mutable source. The
modern path is opt-in (`SURI_MODERN_UPDATES=1`): the host then advertises `updates-v1`
and its `updates.get` snapshot reports `activationSupported: true`, with the
host-owned activation, trial and readiness promotion described above. The retained
launcher verifies the immutable executable inventory before imports and passes a
snapshot to the host. Headless trial/checkpoint tests are not evidence of browser or
native restoration. Automatic application updates are deferred; only the local
development reload loop is implemented.

Keep old build assets for existing windows and lazy-loaded chunks; never replace
files underneath a running page. Other windows do not reload automatically.
Reconnect restores session selection, expanded details, scroll anchor and draft;
Pi child/host identity must remain unchanged and submissions must not repeat.
A ready handshake after mount+subscription marks the build usable; a 10-second
failure offers rollback. Native menu **Reload Previous UI** and a local CLI
recovery action work even when the frontend cannot mount. Packaged original UI
is the fallback if no previous build exists. Do not auto-delete previous assets.

Host, protocol or native-shell changes beyond the advertised compatibility range
cannot activate as a frontend-only update. Report that an idle host restart or
native rebuild is required; never hot-swap host modules, terminate live Pi work or
replace the installed app through Reload UI. This is an explicit local development
loop; it is separate from the deferred automatic application updater.

## Host bootstrap and transport security

Bind only `127.0.0.1`, OS-assigned port. Host owns a mode-0700 runtime directory and
mode-0600 endpoint metadata containing host id, port, PID/start identity and boot
nonce. An OS advisory exclusive lock on `host.lock` is held for host lifetime;
implement a small independently written native locking helper if required by the
Node runtime. Never treat PID existence or a stale JSON marker as ownership.
A second bootstrap reads endpoint metadata only after failing the OS lock, checks
Suri identity/version and returns conflict if unavailable; it never kills a PID.

Native shell starts host with absolute Node/executable paths and passes bootstrap
material through a private pipe. A mode-0600 local control socket, restricted to
the same OS uid, mints a single-use browser bootstrap nonce (60-second lifetime). Exchange once at `/v1/bootstrap` via POST
for a random per-client session cookie: HttpOnly, SameSite=Strict, Path=/,
eight-hour lifetime, renewed only by authenticated same-origin activity. Loopback HTTP is local transport; do not falsely claim TLS.
Browser launch uses a fragment nonce which the Suri bootstrap page immediately
removes with history replacement before POST; never query-string credentials.
No token in logs, screenshots, diagnostics, persisted URLs or protocol examples.
On host restart rotate cookies/nonces and require shell/CLI bootstrap again.

### Model Chain private dispatch broker

Model Chain does not receive browser cookies, CSRF values, bearer secrets, or a
path to such material. For each Suri-owned Pi RPC child, the host attaches one extra private inherited
descriptor. Descriptor non-inheritance is defense in depth, not authorization: an
ordinary tool process is assumed able to reach and write that descriptor. The host
sends a random 256-bit per-process key and channel identity in one startup handshake;
the awaited trusted extension factory consumes them into memory before registering
Model Chain tools. They never enter environment variables, argv, files, journals,
prompts, diagnostics, logs, or tool results.

Every later frame uses canonical versioned bytes, a monotonic channel counter and
HMAC-SHA-256. The host bounds the frame before mutation parsing and silently drops
missing, forged, replayed, reordered, wrong-channel, and tampered frames. A forged
nested-tool frame therefore causes no mutation even when fd 3 is deliberately
inherited. Valid responses are authenticated in the opposite direction. Channel
close, source-process exit, and host shutdown zero the in-memory key where practical
and revoke channel authorizations.

After authenticated `host.get` and before `session.create`, the extension sends the
private-only `stage.register` command with exact canonical workspace/runtime,
request/stage/attempt, provider/model/thinking, target session, expiry, fixed command
sequence, and SHA-256 of the complete bounded prompt. The host validates and retains
that authorization in memory, then enforces exactly
`session.create → model.set → thinking.set → run.submit`, returned revisions, one
reserved target session, empty attachments, exact prompt hash, and one submission.
Submission consumes the authorization. This is not a public Suri Protocol command or
a generic command tunnel. The design replaces the rejected
`SURI_CHAIN_CAPABILITY_FILE` proposal without relying on descriptor secrecy.

Reject noncanonical Host values, non-Suri Origin, cross-origin WS, missing auth,
unsupported methods and wildcard CORS. Cookies are required for HTTP and WS;
mutating HTTP also requires CSRF header bound to bootstrap session. Serve a strict
CSP: self scripts/styles, no remote frames, no unsafe eval, no remote transcript
images. External links open in system browser only after ordinary user click;
WKWebView admits main-frame navigation only to exact host origin. Native bridge
allows named picker/open-external actions with validated parameters, not arbitrary
paths/commands. Bootstrap/security fixtures must pass before any real Pi prompt.

## Suri Protocol v1 wire rules

JSON UTF-8, explicit `v:1`, strings for opaque UUID ids and RFC3339 timestamps.
No Pi types escape the adapter. Validate at ingress and egress. Unknown command
or wrong major returns `UNSUPPORTED_PROTOCOL`/`UNKNOWN_COMMAND`; known event with
unknown optional fields ignores those fields. No inferred authorization from data.

Command envelope:

```json
{
  "v": 1,
  "id": "request-uuid",
  "createdAt": "2026-09-13T00:00:00Z",
  "type": "run.submit",
  "sessionId": "suri-session-uuid",
  "expectedRevision": 4,
  "payload": { "mode": "prompt", "text": "Read hello.txt", "attachmentIds": [] }
}
```

`POST /v1/commands` returns a receipt `{v,id,status,result?,error?}`. Status is
`accepted`, `completed`, `rejected` or `indeterminate`. Only synchronous durable
metadata writes/read results may complete in the response. Async commands return
accepted after host journaling; a later `command.result` communicates Pi acceptance
or failure. Receipt acceptance is never run completion. Error is
`{code,message,retryable,operationId?}` with user-safe message, no raw exception.
Codes include `VALIDATION`, `NOT_FOUND`, `CONFLICT`, `BUSY`, `UNAUTHORIZED`,
`PATH_DENIED`, `RUNTIME_UNSUPPORTED`, `RUNTIME_UNAVAILABLE`, `UPSTREAM_REJECTED`,
`TIMEOUT`, `INTERRUPTED`, `STORAGE_UNAVAILABLE`, `STALE_INTERACTION`,
`LIMIT_EXCEEDED`, `UNKNOWN_COMMAND`, `UNSUPPORTED_PROTOCOL` and `INDETERMINATE`.

Events:

```json
{
  "v": 1,
  "hostEpoch": "boot-uuid",
  "streamId": "session:suri-session-uuid",
  "seq": 42,
  "type": "run.state",
  "at": "2026-09-13T00:00:00Z",
  "sessionId": "suri-session-uuid",
  "runId": "run-uuid",
  "causationId": "request-uuid",
  "payload": { "phase": "idle", "outcome": "completed" }
}
```

`seq` is monotonic persisted integer per stream, never reset on host restart.
`hostEpoch` distinguishes process generation; run ids are Suri ids. Catalog has
`streamId:catalog`; each session has its own stream. Terminal uses its own volatile
stream/epoch. Causation is included only when known, never guessed from last id.
Stable ids, revisions and sequence define order; timestamps are display-only.

### Commands and concrete payloads

Every command carries id. Session commands carry sessionId except create/import.
Expected revision is mandatory for metadata writes and session branch/close/model
changes; mismatch returns conflict without applying. Host serializes mutations per
session while letting cancel and dialog responses bypass long-operation waits.
Read commands may run concurrently with events but return a snapshot watermark.

| Family          | Types and payload/result contract                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Host/catalog    | `host.get` `{}` → protocol/build/runtime identities, capabilities, limits, categorical health; `catalog.get` `{cursor?,limit?}` → project/workspace/session summaries, opaque page cursor (default 100, max 500); `host.shutdown` `{expectedInstanceId?}` explicit lifecycle action, reject if identity changed or work became active before atomic stopping admission                                                                                                                                                                                                                                                                          |
| Projects        | `project.add` `{directoryGrantId,label?}` from native picker or explicit local CLI path registration; `project.update` `{projectId,label?,iconId?}`; `project.forget` `{projectId}` hides catalog entry, rejects active sessions, never deletes files; `workspace.list` `{projectId}`; `workspace.select` `{projectId,candidateId}` validates discovered worktree root before registration                                                                                                                                                                                                                                                      |
| Sessions        | `session.create` `{workspaceId,runtimeId,model?,name?}` → reserved sessionId then readiness event; `session.resume` `{}` → attach/spawn idle process; `session.import` `{fileGrantId,workspaceId,runtimeId}` → validated copied Pi history; `session.rename` `{name}`; `session.archive` `{archived:boolean}`; `session.close` `{}` releases idle process, not history                                                                                                                                                                                                                                                                          |
| Branch/history  | `session.history` `{before?,limit?}` → normalized messages and cursor (100/max500); `session.tree` `{}` → entries with parentId/label/role/activeLeaf; `session.branch` `{entryId}` and `session.clone` `{}` → new Suri sessionId and draft only after Pi success; no arbitrary leaf navigation                                                                                                                                                                                                                                                                                                                                                 |
| Execution       | `run.submit` `{mode:"prompt"                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | "steer"     | "followUp",text,attachmentIds}`; steer/followUp require active run; `run.cancel` `{}`means clear both queues then abort;`run.forceStop` `{}`requires an explicit user action after cancellation timeout and only terminates the owned child;`queue.clear` `{}` → cleared local queue records retained as drafts; arbitrary single-item Pi queue reorder/edit deferred |
| Runtime         | `runtime.list` `{}` → registered identities/status; `runtime.register` `{executableGrantId,expectedVersion}` probes a locally selected installed runtime, never installs; `session.runtime` `{runtimeId}` switches only an idle session using close/backup/reopen with rollback to old mapping on failure; `model.list` `{}`; `model.set` `{provider,id}`; `thinking.list` `{}`; `thinking.set` `{level}`; `commands.list` `{}`; `session.compact` `{instructions?}`. Mutating model/thinking and manual compaction require idle; automatic Pi compaction/retry settings and queue delivery modes are read-only projections of Pi configuration |
| Interaction     | `interaction.respond` `{interactionId,answer:{value}                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | {confirmed} | {cancelled:true}}`; only correct type/options accepted, first answer wins                                                                                                                                                                                                                                                                                             |
| UI metadata     | `preferences.get` `{}` → values/revision; `preferences.patch` `{patch}` allowlisted keys; `session.read` `{throughSeq}` monotonic unread marker; `draft.save` `{text,attachmentIds}` per session/client revision; `icon.set` `{targetId,assetId}` with validated image                                                                                                                                                                                                                                                                                                                                                                          |
| Files/artifacts | `file.list` `{workspaceId,path,cursor?}`; `file.read` `{workspaceId,path,offset?,length?}` → UTF-8/base64 type, content revision/truncation metadata; `file.write` `{workspaceId,path,content,expectedRevision}` atomically replaces an existing bounded UTF-8 workspace file and rejects stale revisions; `file.open`, `file.openWith`, and `file.reveal` accept only a validated workspace file and run only on a local macOS host; `git.status` `{workspaceId}`; `git.diff` `{workspaceId,path?,staged:boolean}` → bounded structured/unified diff; `artifact.get` `{artifactId,offset?,length?}` only host-registered artifacts             |
| Terminal        | `terminal.create` `{workspaceId,cols,rows}` → terminalId; `terminal.attach` `{terminalId,cursor?}` → volatile replay/reset metadata; `terminal.input` `{terminalId,inputId,data}`; `terminal.resize` `{terminalId,cols,rows}`; `terminal.close` `{terminalId}` → exited, explicit user action                                                                                                                                                                                                                                                                                                                                                   |

Attachments use authenticated `POST /v1/attachments` with declared kind/length,
streamed into private host storage; response is artifact/attachment id, no arbitrary
filesystem destination. Directory/file grants are single-use opaque values minted
by local picker/CLI, never supplied absolute paths from untrusted transcript text.
Browser-only project selection uses a local CLI registration until a verified
host-backed picker flow is available; do not expose an unrestricted directory API.
Project icon discovery prefers the DeepSeek Harness (DSH) project convention `.dsh/icon.svg`;
the host validates and rasterizes SVG into private storage before the web client
can display it. Legacy Suri raster candidates remain fallback-only, and an explicit
manual icon always takes precedence over discovery.

### Events and normalized values

| Family      | Event types and minimum payload                                                                                                                                                                                                                          |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Catalog     | `catalog.project`, `catalog.workspace`, `catalog.session` → full summary with revision, tombstone/archived flags, last status and unread seq; no transcript bodies                                                                                       |
| Lifecycle   | `session.state` → phase `starting/idle/running/waiting/compacting/retrying/cancelling/interrupted/closed/failed/unsupported`, revision, runtime identity; `runtime.compatibility` → candidate/verified/unsupported plus safe reason                      |
| Execution   | `run.state` → phase, outcome `completed/failed/cancelled/interrupted/limitReached` only at terminal state, reason code; `turn.state` → turnId, phase; `command.result` → request id, command, accepted/completed/rejected/indeterminate and result/error |
| Messages    | `message.upsert` → messageId, role, ordered blocks, revision, final, optional Pi entryId; `message.delta` → messageId, blockId, blockKind, revision, append text; `message.remove` only for reconciliation with explicit replacement snapshot            |
| Tools       | `tool.state` → callId, messageId, name, phase `pending/running/completed/failed/cancelled/interrupted`, arguments summary, result blocks, truncation; `tool.delta` → callId, blockId, revision, append text                                              |
| Queue       | `queue.state` → ordered steer/followUp records `{queueId,requestId?,text,attachmentIds,state}`; states pending/delivered/cleared/unknown; unmatched upstream items get new opaque ids                                                                    |
| Interaction | `interaction.request` → interactionId, method, title, options/message/prefill as applicable, deadline; `interaction.closed` → resolved/cancelled/expired; `extension.status` → scoped key/text; `extension.widget` → key/placement/plain lines           |
| Resources   | `usage.updated` → input/output/cache tokens, context used/max, optional cost/currency; `compaction.state`/`retry.state` → phase, attempt, delay/deadline, error code; `artifact.ready` → id/kind/size/name                                               |
| Diagnostics | `notice` → severity/code/text/action; `adapter.unknown` → upstream type name, record byte size, safe explanation, no raw payload                                                                                                                         |
| Terminal    | `terminal.output` → terminalId, byte cursor, base64 bytes; `terminal.state` → running/exited/lost, exitCode optional; `terminal.reset` → new epoch and dropped-prefix count                                                                              |

Content block tagged union: text `{text}`, thinking `{text,visibility}`, code
`{text,language?}`, image `{artifactId,mime,width?,height?,alt?}`, toolCall
`{callId,name,arguments}`, toolResult `{callId,isError,blocks}`, custom
`{label,text}`, unknown `{label}`. JSON arguments/results are validated, bounded
and rendered as inert text. Never forward thinking signatures, opaque provider
metadata, headers or unvalidated HTML. Usage is optional; missing thinking is not
invented. StopReason length yields limitReached, not completed.

### Replay, idempotency and concurrency

`WS /v1/events` accepts subscribe `{v:1,type:"subscribe",streamId,afterSeq?,hostEpoch?}`
and unsubscribe `{v:1,type:"unsubscribe",streamId}`. The client detaches the
previous session stream when navigation changes so background output cannot
accumulate rendering work in every session visited by that window.
Host takes a serialization barrier, registers the subscriber, captures snapshot
at S, emits `{type:"snapshot",streamId,seq:S,payload:...}` or replays `(afterSeq,S]`,
then flushes queued live events `>S`. Client deduplicates seq, requires contiguous
sequences, and coalesces projection paints to one update per animation frame while
advancing its sequence head synchronously. Gap, expired cursor, wrong epoch, overflow or incompatible projection
forces snapshot reset, never silent skipping. Event+reducer projection update is
one SQLite transaction before publish. Snapshot contains active partial messages,
pending dialogs/queues and the last 100 messages; older history is paged.
If snapshot exceeds a frame, send `snapshot.begin {snapshotId,seq,parts,sha256}`,
ordered `snapshot.part {snapshotId,index,dataBase64}` frames (≤512 KiB encoded
payload each), then `snapshot.end {snapshotId}`. Client validates count/hash and
atomically replaces state only at end; buffer later live events until then.
Missing/oversized parts or a 10-second assembly timeout restart subscription.
Limit assembled snapshot to 32 MiB; use artifact-backed content and history paging
to remain within it. Large individual message bodies are artifacts, not giant
upsert frames. Replay uses the same artifact references as live delivery.

Retain replay up to 10,000 events or 24 hours per session (whichever expires first),
with newest durable snapshot retained. This is not a full transcript archive; Pi
history remains canonical. Trim only after snapshot commit. A slow subscriber
with >4 MiB queued is disconnected and must resnapshot; Pi reading continues.
Flush text deltas in batches ≤50 ms while keeping final/error boundaries immediate.
Limit upstream JSON record to 32 MiB, WebSocket frame 1 MiB; split normalized large
outputs into artifacts with truncation indicators. No unbounded memory queues.

Persist command id + payload hash before dispatch. Same id and payload returns
previous receipt/result for 7 days; same id with different payload is conflict.
Do not retain submitted secrets in command logs. Payload hash and safe envelope
metadata suffice; user message text is retained only in the protected content
store/draft where required. After dedupe expiry, reject stale client timestamp
instead of re-executing (command envelope additionally includes `createdAt`; max
age seven days, five-minute future skew). Browser persists outbox ids until result.

There is no atomic transaction across SQLite and Pi/tool effects. Host death after
dispatch but before result produces `indeterminate`; never resend automatically.
On recovery reconcile Pi state/history and expose uncertain delivery. User chooses
whether to submit anew. Terminal input is deduped within live terminal epoch only;
on reconnect uncertain keystrokes are not replayed. Reconnect retries are bounded
exponential 0.25, 0.5, 1, 2, 4, then 5 seconds with jitter while window is open;
show disconnected immediately and disable new mutations until subscribed.

## Persistence ownership and migrations

macOS data root: `~/Library/Application Support/Suri Pi/`; portable tests override
`SURI_DATA_DIR` to a temporary directory. Do not use Pi config folders for Suri UI.
`state.sqlite` owns preferences/catalog/assets metadata; `runtime/` contains
Pi-written JSONL grouped by Suri workspace/session; `assets/` contains user icons
and attachments; `run/` private ephemeral lock/endpoint/socket files. Contents are
private local application data, not logs; permissions 0700/0600, no claim of
application-level encryption. Do not export automatically.

Schema v1 tables (all ids opaque, foreign keys enforced):

- `schema_migrations(version PK, checksum, applied_at)`;
- `preferences(key PK, json_value, revision)` with theme=light, density=compact,
  sidebar width, detail width, font scale, shortcuts, reduced-motion override;
- `projects(id PK, canonical_root UNIQUE, label, icon_id, revision, forgotten)`;
- `workspaces(id PK, project_id FK, canonical_root UNIQUE, git_common_dir?, branch?, revision)`;
- `sessions(id PK, workspace_id FK, pi_session_id?, pi_file?, parent_id?, display_name,
icon_id?, archived, runtime_id, revision, created_at, updated_at, last_read_seq)`;
- `runtimes(id PK, executable_path, package_version, artifact_identity, adapter_version,
validation_status, validated_at?, evidence_id?)`;
- `assets(id PK, sha256 UNIQUE, kind, mime, bytes, relative_path)`;
- `drafts(session_id, client_id, text, attachment_ids_json, revision, composite PK)`;
- `commands(id PK, payload_hash, safe_envelope_json, status, result_json?, created_at)`;
- `stream_heads(stream_id PK, seq)`, `events(stream_id,seq,type,payload_json,at, composite PK)`;
- `snapshots(stream_id PK, seq, projection_version, payload_json)`.

Transcript content and queue/dialog bodies in events/snapshots are sensitive
application content, never diagnostic logs. Limit retention above; idle projections
page/cap messages, no unlimited parsed transcript cache. Keep draft attachments
until explicit draft removal; automatic cleanup applies only expired derived
replay/temp files, never Pi history or user icons. Archive is reversible metadata.

Single writer, SQLite WAL, foreign keys, bounded busy timeout (5 sec). Before schema
migration stop ingress, require no active runs, back up via SQLite backup API,
apply ordered checksum-verified migration in a transaction, then integrity check.
On error roll back and keep backup; never wipe/recreate. Newer unsupported schema
opens recovery UI without writes. Downgrade does not run reverse migrations.
Migration fixture v1→v2 adds a preferences field solely to demonstrate defaults,
unknown preference preservation, crash rollback and id/icon/layout stability.
Pi version switches do not call these migrations. Pi may migrate its own history;
back up an idle Pi file before switching runtime and retain runtime-specific copy
if backward compatibility is unproven. Never open same file with two Pi versions.

## Process lifecycle and failure

Only a separately authorized host-owned validation capability may promote a real runtime; normal app starts require verified identity. Registration alone remains candidate and arbitrary maintenance JSON has no catalog-write route. The local CLI requires explicit provider/model/agent-directory arguments plus `--confirm-provider-spend`, then uses the private same-user control socket to mint a one-use, 60-second validation grant. The running host consumes that grant, owns the real Pi acceptance job and its shutdown drain, re-probes after acceptance, atomically retains bounded mode-0600 evidence under the private data root, and updates the existing runtime catalog identity only after validation. A browser command without that control-socket grant and simulated hosts cannot promote a runtime. Evidence must bind the declared canonical Pi entrypoint, loader/distribution/dependency identity, exact adapter identity and every required real acceptance case: spawn, stream, tool-call, cancel, reconnect, resume and persistence. It also requires a UUID evidence identity and canonical validation timestamp within the bounded seven-day freshness window and five-minute clock skew; missing, ancient, future, simulated, extra-case or incomplete evidence cannot promote live use. The host re-probes the executable before every non-simulated launch; changed identity invalidates it. Persisted legacy identities therefore require this real revalidation rather than a direct SQLite rewrite; successful promotion preserves the runtime id and all session references.

Pi children have no fixed application count cap (capacity depends on system
resources); PTYs retain their separate four-process limit. A host-owned 30-second
sweep gracefully closes persisted Pi children after 15 minutes without activity.
Active phases, queued work, startup/submission, pending RPC, image persistence and
extension questions prevent retirement. Catalog/history remain and next use resumes
the saved Pi file. Never silently evict active work. Overlapping use waits up to
five seconds for retirement exit, then gives a specific retained-draft error if
shutdown stalls; it never retries a prompt or force-kills the child.
Create reserves metadata before spawn, waits at most 15 sec for `get_state`, then
validates session identity/file against reserved metadata (cwd is the explicit
spawn argument, not a get_state field), captures initial state and publishes idle. A fresh
RPC process already has a new session: do not issue new_session unnecessarily.
Coalesce concurrent resume/create requests for the same identity.

Maintain one owned process per Pi file. Fork is idle-only: use the parent process's
public fork/clone, obtain new identity, then transfer that process binding to a
new Suri session and mark parent idle/unloaded. Parent's later resume gets its own
process. Cancelled fork leaves mappings untouched. On failure between Pi fork and
metadata commit, mark reconciliation required and inspect owned files/state;
never pretend fork succeeded or delete either branch.

Read/query timeout 10 sec; accepted prompt is long-running and has no generic
10-sec turn deadline. Stop freezes new submissions, clears Pi queues, records
restored drafts/attachment ids, then aborts (10 sec). If no idle/settled response,
show cancellation pending and offer explicit force-stop; do not force-kill after
an ordinary Stop automatically. Explicit force-stop uses SIGTERM only for a proven owned child process group. Host shutdown closes stdin and waits up to five seconds for each owned runtime; a stalled child produces a bounded shutdown failure and ownership/lock are retained rather than claiming success or silently escalating. Interrupted outcome provides no guaranteed rollback of tool effects. General child crashes do not
restart/resubmit. Cancel status is not published solely from button press.

On UI close: detach subscriptions, keep host/children and pending interactions.
On requested shutdown: atomically refuse new writes/bootstrap while retaining bounded health, drain accepted jobs and ingress, close HTTP/WebSockets, wait for owned runtime and PTY exits, flush pending transcript/artifact writes, close storage, release the OS lock, then close control. Live or stopping terminals and pending transcript/artifact writes are included in `activeWork`. Restart proves a different instance identity on the same address. On unexpected host death stdin EOF should cause
Pi disposal, but abandoned subprocess descendants are possible; next host reports
uncertain/orphaned state and never kills based only on saved PID. New host epoch
resets clients, marks formerly active runs/PTYs interrupted/lost and allows explicit
resume from persisted Pi history only after prior process ownership is proven
released. If an orphan may still own the file, block resume and request resolution;
a click on Resume is not proof that a previous writer died. No claim of live-turn
survival through host crash.
Storage failure disables mutations, keeps reading child output within bounded
memory, marks durability lost, and requests user action; never silently drops
events while showing a durable/reconnected success state.

## Workspace, file, terminal and credential boundaries

Registered realpaths are explicit user-selected capabilities for Suri APIs. Reject
absolute/drive/UNC/NUL paths and any `..` segment before resolution. Do not infer
new roots from tool output or imported session paths. Before importing/resuming a
file, read only its bounded documented session header and require its canonical
cwd to equal the selected root; unknown header version fails. Do this before any
Pi startup/resource discovery, then let Pi validate the copied owned transcript.
A later get_state validates session id/file, not cwd (which it does not expose).
File access walks relative
components without following symlinks (including intermediates) using descriptor-
relative no-follow operations; directories are anchored by a root descriptor.
Use a small native helper if necessary; `realpath` then ordinary open alone is
not sufficient against a symlink swap. V1 file tree marks symlinks as links and
does not open them. Test real symlink swaps, siblings with shared name prefixes,
nonexistent files, Unicode, spaces and concurrent rename. This restriction is
Suri file-API policy, not a restriction on the Pi agent or interactive terminal.

Read preview cap 1 MiB (paged text), directory pages max 500 entries; never walk
entire home directory. Binary files show metadata/download only; HTML/SVG render
as source, not active markup. Images accept PNG/JPEG/WebP up to 10 MiB each, at
most four attached per message and 20 MiB total decoded upload; ordinary text
attachments max 1 MiB each, combined prompt text max 1 MiB. Non-image attachments
become explicitly delimited text with filename; unsupported types are rejected
with explanation, never silently ignored. Icon images max 1 MiB and 512×512;
validate/decode raster data, reject SVG/script payloads. Pi image output becomes
private artifact ids. No remote image fetch from Markdown.

Git uses fixed executable + argv (`status --porcelain=v2 -z`, `diff --no-ext-diff
--no-textconv`, `worktree list --porcelain -z`), disables optional locks for reads,
respects workspace roots and validates paths; no shell interpolation, Git hooks,
commit/push/checkout/worktree mutation endpoints in v1. PTY creation is explicit,
uses user's selected shell with workspace cwd and 1 MiB volatile replay. Resize
bounds 2–500 cols and 1–300 rows. OSC clipboard/file actions are disabled in xterm;
link opens require user action. Terminal output is not a persistent diagnostic log.

Pi alone owns credentials and ordinary credential refresh. Suri chooses existing
profile by local configuration, passes only needed environment without logging it,
and never copies auth storage or modifies global Pi settings. Session model and
thinking changes use RPC only: inspected candidate implementations persist these
to session history without global defaults unless persist is explicitly requested.
Do not send set_auto_compaction, set_auto_retry, set_steering_mode or
set_follow_up_mode: their public RPC handlers write Pi settings. Display current
values and retain the externally configured modes. Slash commands/extensions
remain user-invoked Pi code and may have their own effects; Suri must not
automatically run configuration commands. Test settings-file hashes around all
Suri-generated runtime commands in a temporary profile. Fixture tests use a
no-secret temporary profile;
real provider calls are never made by the automated suites.

For the user-requested Codex weekly allowance display, the host asks the pinned Pi
runtime for an `openai-codex` bearer token through Pi's public
`auth print-bearer-token` command, keeps that token in process memory only, and
performs an account-scoped read of ChatGPT's undocumented `/backend-api/wham/usage`
endpoint. This narrow compatibility boundary may break independently of Pi: parse
only bounded percentage/window/reset fields, cache only sanitized output for one
minute, and degrade to unavailable. Never persist, return, or log the token,
account id, raw response, or provider error. No usage read may block session context.

## Preserved contracts

Six reviewed behaviors are kept unchanged and pinned by focused tests; [module ownership](module-ownership.md#preserved-contracts) lists each with its test.

- Identical `runtime.validate` polls start one validation job ([test](../tests/integration/cp2-contracts.test.ts)).
- Unreadable or non-matching import history is a bounded `PATH_DENIED`; an OS read refusal stays the generic internal error.
- `file.write` is update-only: no file creation, no symlink following, and a binary target answers `CONFLICT` without mutation.
- `icon.clear` needs the current revision; missing or stale is `CONFLICT`.
- Bootstrap nonces are single use and consumed on rejection; an expired or replayed nonce never sets a cookie ([test](../tests/integration/host-concurrent-renewal.test.ts)).

The final transport, completion and artifact ownership boundaries (per-secret socket expiry and revocation, the `async_completions` marker with `ASYNC_INTERRUPTED` recovery and retryable close, artifact ownership and fallback, submission admission and accepted-write drain) are in [module ownership](module-ownership.md#transport-completion-and-artifact-boundaries). Coverage is bounded to the cited tests.
