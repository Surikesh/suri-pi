# ADR-004 — Independent persistent single host

Status: accepted, 2026-09-13.

Basis: a session daemon must own session lifecycle, a sequence-watermark join
for reconnecting clients, shutdown and PTY services.

Choose a detached Node 24 LTS host with HTTP/WS/static serving, one adapter child
per live session, single OS-locked data owner, four-session default capacity,
SQLite journal/snapshots and authenticated loopback clients. The behaviors are implemented independently; no third-party host code is adapted. See [architecture](../architecture.md)
for exact process and replay semantics.

Alternatives: UI-owned children lose work on close; adopting an existing session daemon inherits
plugin, auth and fleet concepts; separate web-server and daemon adds a private hop
without local-first benefit. A worker daemon per session adds too many independent
journals and update boundaries for v1.

Consequences: window disconnect is survivable, host crash interrupts work;
OS-level tool effects are not transactional. No automatic prompt resubmit after
ambiguous dispatch. PTY replay is bounded/volatile, history persists in Pi. A
future host split must preserve Suri wire semantics and user-store ownership.
