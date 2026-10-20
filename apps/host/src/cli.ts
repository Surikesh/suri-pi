import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  StartupBoundaryError,
  writeStartupFailure,
  type StartupFailure,
} from "./preflight.js";
import { CliFailure } from "./cli-env.js";
import { runServe, runDoctor, runStatus } from "./cli-main-simple.js";
import { runUpdates } from "./cli-updates.js";
import { runAction } from "./cli-submit.js";

export { resolveLaunchFailure } from "./cli-ensure.js";
export {
  assertCompatibleHealth,
  assertShutdownReceipt,
  control,
} from "./cli-control.js";

function main(): Promise<void> {
  const [action = "open", ...args] = process.argv.slice(2);
  if (action === "serve") return runServe();
  if (action === "updates") return runUpdates(args);
  if (action === "doctor") return runDoctor();
  if (action === "status") return runStatus();
  return runAction(action, args);
}
export async function runCli() {
  await main().catch(async (error: unknown) => {
    const detail =
      error instanceof CliFailure
        ? error.detail
        : error instanceof StartupBoundaryError
          ? error.detail
          : ({
              ok: false,
              stage: process.argv[2] === "serve" ? "child" : "control",
              code:
                process.argv[2] === "serve"
                  ? "HOST_START_FAILED"
                  : "CLI_INTERNAL_FAILURE",
              retryable: false,
              action:
                "Do not retry until the owning lifecycle boundary reports a specific category.",
            } satisfies StartupFailure);
    if (process.argv[2] === "serve")
      await writeStartupFailure(process.env.SURI_STARTUP_STATUS, detail);
    console.error(JSON.stringify(detail));
    process.exitCode = 1;
  });
}

if (
  process.argv[1] &&
  // An unresolvable argv path means this module is not the entry point.
  (await realpath(resolve(process.argv[1])).catch(() => undefined)) ===
    (await realpath(fileURLToPath(import.meta.url)))
)
  await runCli();
