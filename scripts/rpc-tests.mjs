import { execFileSync } from "node:child_process";
const requested = process.argv
  .find((a) => a.startsWith("--versions="))
  ?.split("=")[1]
  ?.split(",") ?? ["0.84.4", "0.85.1"];
if (requested.some((v) => !["0.84.4", "0.85.1"].includes(v)))
  throw Error("Unsupported fixture version");
execFileSync(
  "node_modules/.bin/vitest",
  [
    "run",
    "tests/unit/rpc-fixtures.test.ts",
    "tests/unit/rpc-boundary-fixtures.test.ts",
  ],
  {
    stdio: "inherit",
    env: { ...process.env, SURI_FIXTURE_VERSIONS: requested.join(",") },
  },
);
