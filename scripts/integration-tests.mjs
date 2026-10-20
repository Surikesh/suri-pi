import { execFileSync } from "node:child_process";
// Update, restart and migration tests launch the staged contract-2 host from
// .build, so it must be built from the current sources first.
execFileSync(process.execPath, ["scripts/build-updates.mjs"], {
  stdio: "inherit",
});
execFileSync("node_modules/.bin/vitest", ["run", "tests/integration"], {
  stdio: "inherit",
});
