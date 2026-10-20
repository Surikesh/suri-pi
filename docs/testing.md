# Testing

All automated suites are synthetic. They use fake Pi processes and synthetic Pi RPC
transcripts, temporary data directories and loopback hosts. None calls a model
provider or needs credentials, and none touches your real Suri data. What they
cannot show is how a real Pi installation or a real provider behaves; that needs
manual use (see the README, "Use it with Pi").

Most suites import build output, so run `npm run build` first. The first-time
setup is in the README.

## Suites

| Command                      | What it runs                                                                                  | What it proves                                                                                                                                                |
| ---------------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run typecheck`          | `tsc --noEmit` over every workspace                                                           | Types agree across packages, host, web and tests                                                                                                              |
| `npm run lint`               | ESLint, `scripts/check-boundaries.mjs`, `scripts/check-exports.mjs`, `scripts/check-docs.mjs` | Style rules, allowed import edges between packages and apps, that every package export has a consumer, and that README/docs commands, links and paths exist   |
| `npm run format:check`       | Prettier over code, scripts, tests and JSON                                                   | Formatting (`npm run format` rewrites)                                                                                                                        |
| `npm run test:unit`          | Vitest, `tests/unit`                                                                          | Pure logic: protocol schemas, adapter translation and framing, storage, reducers, file preview, boundary rules, broker framing                                |
| `npm run test:rpc`           | Vitest over `tests/fixtures/pi/`                                                              | The adapter handles synthetic Pi 0.84.4 and 0.85.1 RPC transcripts (`--versions=0.85.1` limits it); no Pi process is started                                  |
| `npm run test:integration`   | Stages the update build, then Vitest over `tests/integration`                                 | A real host process with a fake Pi: command dedupe, replay and recovery, transport security, files, PTY, storage faults, migrations, update and restart flows |
| `npm run test:e2e`           | Playwright journeys in Chromium and WebKit against fixture hosts                              | Browser behavior: transcript, composer, navigation, details panel, terminal, reconnect, update and restart handoff                                            |
| `npm run test:a11y`          | Playwright with axe, `--grep accessibility`                                                   | No automated accessibility violations in the covered views                                                                                                    |
| `npm run test:updates`       | Build staging, the update and restart unit and integration tests, three Playwright specs      | The UI update, host restart and rollback flow                                                                                                                 |
| `npm run test:recovery`      | Node test runner with injected IO                                                             | The recovery tool's decisions                                                                                                                                 |
| `npm run test:recovery:live` | Node test runner, isolated real host and PTY (macOS only; skipped elsewhere)                  | The recovery tool against a real host                                                                                                                         |

Also available: `test:e2e:serial` (one worker, for diagnosing concurrency),
`test:ui-fixtures` (plain `playwright test`), `test:executor:fixture`,
`test:self-edit` and `test:migrations` (single integration files), and
`verify:portable`, which runs the portable subset in CI order.

## Playwright

`npm run test:e2e` first stages the update build, then runs two stages:

- `tests/e2e/app.spec.ts` on one worker, because it mutates one seeded fixture
  server (`scripts/e2e-server.mjs`).
- Every other spec on up to four workers; each test owns a temporary host,
  workspace and dynamic port through `browserHost()`.

The fixture server port is chosen free by the runner. Set `SURI_E2E_PORT` to pin it
(for example when the default 4310 is taken by the plain `playwright test` entry
points) and `SURI_E2E_WORKERS=N` to change the isolated worker count. Install the
browsers once with `npx playwright install chromium webkit`.

Wall-clock budgets in e2e specs go through `perfBudget()` (`tests/e2e/perf-budget.ts`);
set `SURI_E2E_PERF_SCALE=3` (>= 1) to multiply them on slower machines, as CI does. With
`CI` set, Playwright retries failed tests twice and a test that passes on retry counts as flaky, not failed.

## Native shell (macOS, optional)

`npm run package:macos` builds the SwiftUI shell into an ad-hoc signed `.app`, and
`npm run test:native-dev-host` and `npm run test:native-restart` exercise it with
synthetic data. They are experimental and are not part of CI. They expect an
official Node 24.15.0 macOS arm64 distribution unpacked at
`.runtime/node/node-v24.15.0-darwin-arm64/` (download it from nodejs.org), and a
prior `npm run build` plus, for the restart test, `npm run build:updates`.

## Choosing what to run

- While changing code, run the affected test file: `npx vitest run tests/unit/<file>`.
- Before sending a change, run `typecheck`, `lint`, `format:check`, `test:unit`,
  `test:rpc` and `test:integration`; add one focused Playwright spec when browser
  behavior changed, and `test:e2e` when the change can affect unrelated journeys.
- Real-Pi and native checks are manual and only relevant when that boundary changed.

## Flaky tests

A failing test is a defect until shown otherwise. Do not re-run a whole suite to
diagnose one failure: reproduce the single test, at most three times. A test that
passes and fails on the same commit is flaky; fix its wait or fixture rather than
adding retries (Playwright runs with none), and until then report it separately
instead of hiding it in an unrelated change. Never mark a failing assertion as
passing or weaken it to make a run green.
