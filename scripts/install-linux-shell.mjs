import { chmod, copyFile, mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve, join } from "node:path";

if (process.platform !== "linux")
  throw Error("The Linux shell can only be installed on Linux.");
const repo = resolve(".");
const home = homedir();
const binDir = join(home, ".local/bin");
const appDir = join(home, ".local/share/applications");
const iconDir = join(home, ".local/share/icons/hicolor/scalable/apps");
await Promise.all([
  mkdir(binDir, { recursive: true }),
  mkdir(appDir, { recursive: true }),
  mkdir(iconDir, { recursive: true }),
]);
const launcher = join(binDir, "suri-pi");
await writeFile(
  launcher,
  `#!/bin/sh\nset -eu\ncd ${JSON.stringify(repo)}\nexec ${JSON.stringify(process.execPath)} dist/apps/host/src/cli.js open\n`,
  { mode: 0o755 },
);
await chmod(launcher, 0o755);
await copyFile(
  join(repo, "apps/web/public/icon.svg"),
  join(iconDir, "suri-pi.svg"),
);
await writeFile(
  join(appDir, "suri-pi.desktop"),
  `[Desktop Entry]\nType=Application\nName=Suri Pi\nComment=Local graphical client for Pi Coding Agent\nExec=${launcher}\nIcon=suri-pi\nTerminal=false\nCategories=Development;IDE;\nStartupWMClass=SuriPi\n`,
);
console.log(`Installed the Linux shell at ${launcher}`);
