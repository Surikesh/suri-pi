import { execFile, spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const checkout = resolve(".");
const bundle = resolve(".build/Suri Pi.app");
const executable = join(bundle, "Contents/MacOS/SuriPi");
const bundledNode = join(bundle, "Contents/Resources/app/bin/node");
const checkoutCli = join(checkout, "dist/apps/host/src/cli.js");
const root = await mkdtemp(join(tmpdir(), "suri-native-development-host-"));
const environment = {
  ...process.env,
  SURI_DATA_DIR: root,
  SURI_DEVELOPMENT_CHECKOUT: checkout,
};
const shell = spawn(executable, [], { env: environment, stdio: "ignore" });

try {
  let endpoint;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      endpoint = JSON.parse(
        await readFile(join(root, "run/endpoint.json"), "utf8"),
      );
      const response = await fetch(endpoint.origin);
      if (response.ok) break;
    } catch {
      // Host not ready yet: retry after the delay.
    }
    endpoint = undefined;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!endpoint) throw Error("The development host did not start.");

  const { stdout: command } = await exec("/bin/ps", [
    "-p",
    String(endpoint.pid),
    "-o",
    "command=",
  ]);
  if (!command.includes(checkoutCli))
    throw Error(
      "The native shell started its packaged host instead of the checkout host.",
    );

  const health = JSON.parse(
    (await exec(bundledNode, [checkoutCli, "doctor"], { env: environment }))
      .stdout,
  );
  if (!health.preflight?.ok || health.host?.present !== true)
    throw Error(
      `The checkout host failed its bounded health check (${health.host?.control?.code ?? "PREFLIGHT_OR_HOST_UNAVAILABLE"}).`,
    );

  console.log(
    "Native shell launched and reached the development checkout host: passed.",
  );
} finally {
  try {
    await exec(bundledNode, [checkoutCli, "shutdown"], { env: environment });
  } catch {
    // Best effort: the host may already be stopped; the shell is killed next either way.
  }
  shell.kill("SIGTERM");
  await new Promise((resolve) => setTimeout(resolve, 300));
  await rm(root, { recursive: true, force: true });
}
