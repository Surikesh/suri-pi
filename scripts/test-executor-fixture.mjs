import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { buildUi } from "./build-ui.mjs";

// Build a fresh immutable UI for the isolated host; never replace the UI of a regular profile.
const ui = await buildUi();
const options = { cwd: resolve("."), stdio: "inherit", timeout: 120_000 };
execFileSync(
  process.execPath,
  [
    "node_modules/vitest/vitest.mjs",
    "run",
    "tests/integration/idle-runtimes.test.ts",
  ],
  options,
);
execFileSync(
  process.execPath,
  [
    "node_modules/playwright/cli.js",
    "test",
    "tests/e2e/browser-contract.spec.ts",
    "--grep",
    "cold session keeps built-in slash commands",
    "--workers=1",
  ],
  {
    ...options,
    env: { ...process.env, SURI_E2E_UI_ASSETS: ui.path },
  },
);
console.log(
  "Executor fixture: cold commands, explicit Pi resume, compact, retirement and reconnect passed in Chromium and WebKit. No real provider was used.",
);
