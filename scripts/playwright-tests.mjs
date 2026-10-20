import { availableParallelism } from "node:os";
import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { createServer } from "node:net";

const playwright = join("node_modules", ".bin", "playwright");
const allSpecs = readdirSync("tests/e2e")
  .filter((name) => name.endsWith(".spec.ts"))
  .sort()
  .map((name) => `tests/e2e/${name}`);
const sharedSpecs = ["tests/e2e/app.spec.ts"];
const isolatedSpecs = allSpecs.filter((path) => !sharedSpecs.includes(path));
const requestedWorkers = Number(process.env.SURI_E2E_WORKERS);
const parallelWorkers =
  Number.isInteger(requestedWorkers) && requestedWorkers > 0
    ? requestedWorkers
    : Math.max(2, Math.min(4, availableParallelism() - 1));

// The shared fixture server needs one fixed port for the whole run; pick a free
// one unless the caller chose it.
if (!process.env.SURI_E2E_PORT) {
  process.env.SURI_E2E_PORT = String(
    await new Promise((resolve, reject) => {
      const probe = createServer();
      probe.once("error", reject);
      probe.listen(0, "127.0.0.1", () => {
        const { port } = probe.address();
        probe.close(() => resolve(port));
      });
    }),
  );
}

function run(label, specs, workers) {
  const started = Date.now();
  console.log(JSON.stringify({ stage: label, specs: specs.length, workers }));
  const result = spawnSync(
    playwright,
    ["test", ...specs, `--workers=${workers}`],
    { stdio: "inherit", env: process.env },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
  console.log(
    JSON.stringify({
      stage: label,
      passed: true,
      durationMs: Date.now() - started,
    }),
  );
}

// Retained-host specs launch the staged contract-2 host from .build; `npm run
// build` only stages the legacy contract-1 host, so stage the modern one here.
const staged = spawnSync(process.execPath, ["scripts/build-updates.mjs"], {
  stdio: "inherit",
});
if (staged.error) throw staged.error;
if (staged.status !== 0) process.exit(staged.status ?? 1);

// app.spec.ts mutates one shared deterministic fixture server. Keep that file
// serial while allowing every per-test browserHost fixture to run concurrently.
run("shared-fixture", sharedSpecs, 1);
run("isolated-fixtures", isolatedSpecs, parallelWorkers);
