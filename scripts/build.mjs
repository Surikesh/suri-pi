import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { buildUi } from "./build-ui.mjs";
import { compileHelper } from "./native-helper.mjs";
import { buildHost } from "./build-host.mjs";
const ptyHelper = `node_modules/node-pty/prebuilds/${process.platform}-${process.arch}/spawn-helper`;
if (existsSync(ptyHelper)) chmodSync(ptyHelper, 0o755);
mkdirSync("dist/native", { recursive: true });
compileHelper("dist/native/suri-helper", {
  flags: ["-Wall", "-Wextra", "-O2"],
});
execFileSync("node_modules/.bin/tsc", ["-p", "tsconfig.json"], {
  stdio: "inherit",
});
const ui = await buildUi({ compatibilityOutput: true });
console.log("Built UI candidate (not activated): " + ui.buildId);
const host = await buildHost();
console.log("Built host candidate (not running): " + host.buildId);
