import { spawnSync } from "node:child_process";
const result = spawnSync("node_modules/.bin/playwright", ["test"], {
  stdio: "inherit",
});
process.exit(result.status ?? 1);
