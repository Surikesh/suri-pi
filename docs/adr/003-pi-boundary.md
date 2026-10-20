# ADR-003 — Public subprocess RPC, no SDK hybrid

Status: accepted, 2026-09-13.

Basis: Pi's documented RPC mode covers send/queue/stop, sessions/fork/tree
inspection, models and extension dialogs; the pinned versions' RPC types and
implementation were compared with the SDK.

Choose one RPC child per live session, independently written JSONL adapter,
exact candidate versions 0.85.1 and 0.84.4 promoted only by actual checks. Reject
0.85.0 and unknown versions; no broad supported range inferred from peers.

Alternatives: SDK embedding is officially suggested for Node clients and gives
richer loaders/tree access, but expands runtime/global-state ownership and package
coupling. Hybrid needs two semantics and validation paths. Third-party plugin exports
are not a better independent agent service boundary.

Consequences: Suri supplies catalog, idempotency, replay, file and PTY facilities;
TUI custom UI and arbitrary leaf navigation are deferred. Global settings-writing RPC toggles are excluded; model/thinking defaults
remain session-scoped. Clear queues before abort; only agent_settled closes a run. Upstream errors/unknown records do not
become success. Frontend and persistence never import Pi SDK types.
