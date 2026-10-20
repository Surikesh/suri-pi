# ADR-001 — React, TypeScript and Vite

Status: accepted, 2026-09-13.

Sources: React's [external-store contract](https://react.dev/reference/react/useSyncExternalStore)
supports stable snapshots; [Vite](https://vite.dev/guide/) provides the browser build
boundary.

Choose React + TypeScript + Vite, native CSS variables, Suri reducer/store,
react-markdown/remark-gfm without raw HTML, Shiki and xterm for bounded specialist
renderers. Exact versions are pinned in `package-lock.json`; there are no floating upgrades. Reducer tests operate
without React; the frontend imports only Suri Protocol v1.

Alternatives: Lit has no architectural benefit that outweighs
rewriting our own streaming state anyway; SwiftUI-only duplicates rich transcript
rendering; a server-rendered meta-framework adds a server boundary without a v1
requirement. This is an engineering choice, not evidence of measured superiority.

Required self-development: feature modules and versioned static builds allow a
Pi session in Suri to edit Suri frontend source, then reload only its webview.
The host/protocol compatibility manifest and native rollback path are specified
in architecture.md; UI updates do not require a host restart.

Consequences: stream batching, stable ids and history virtualization are mandatory;
validate 10,000-message and narrow layouts before claiming performance. No global
store shared with other tools and no themed component kit. Pi upgrades terminate in the adapter and
cannot alter CSS, layout or persisted preferences.
