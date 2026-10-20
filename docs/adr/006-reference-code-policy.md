# ADR-006 — Independent concepts, explicit third-party notices

Status: accepted, 2026-09-13.

Basis: the MIT licenses of Pi, DeepSeek Harness (DSH) and the PI WEB project were
read before choosing this policy.

Choose zero source adaptation from DSH or PI WEB for v1. DSH supplies observed
visual/interaction rules; PI WEB supplies backend lessons; Pi supplies public RPC.
All three upstream license files are MIT (DeepSeek 2026, Federico
Jaramillo Martinez 2026, Mario Zechner 2025 respectively). DSH's native wrapper has no
separate license and is not copied. The one exception is the file-type icon
artwork and filename tables in `apps/web/src/dsh-file-icons.tsx`, adapted from DSH
under its MIT license and recorded in `THIRD_PARTY_NOTICES.md`.

Alternatives: narrow MIT module adaptation is legally possible subject to exact
review, but current modules bring host/plugin/SDK coupling. A frontend fork or
skin violates product intent even when a license permits copying.

Consequences: apart from the icon exception, independent implementation needs no
reference-code notices; conceptual provenance is recorded in these notes.
`THIRD_PARTY_NOTICES.md` is generated from the locked dependency artifacts.
Retain full copyright/license text for distributed dependencies and any substantial
copied material, including docs/fixtures if copied. Product branding is original; upstream MIT is not a blanket artwork license.

Any future adaptation requires a recorded decision before inclusion: exact source
commit/path/range, license, destination, modifications, attribution and test owner.
Incompatible or unknown redistribution rights stop that inclusion. No
other third-party implementation code is copied.
