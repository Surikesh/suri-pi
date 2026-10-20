import { spawn } from "node:child_process";
import { cp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { control } from "../apps/host/src/cli.js";
import { restartFixture } from "../tests/support/restart-fixture.js";

const delay = (ms: number) => new Promise((done) => setTimeout(done, ms));
const fixture = await restartFixture();
const executable = resolve(".build/Suri Pi.app/Contents/MacOS/SuriPi");
const diagnostics = join(fixture.root, "native-restart.json");
const shell = spawn(executable, ["--navigation-diagnostics", diagnostics], {
  env: {
    ...process.env,
    SURI_DATA_DIR: fixture.data,
    SURI_DEVELOPMENT_CHECKOUT: resolve("."),
  },
  stdio: "ignore",
});

async function waitFor<T>(
  inspect: () => Promise<T | undefined>,
  message: string,
  attempts = 200,
): Promise<T> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    // Not observable yet (undefined): poll again until the shell exits or attempts run out.
    const value = await inspect().catch(() => undefined);
    if (value !== undefined) return value;
    if (shell.exitCode !== null)
      throw Error(`Native shell exited before ${message}.`);
    await delay(100);
  }
  throw Error(`Timed out waiting for ${message}.`);
}

try {
  const initialDiagnostic = await waitFor(async () => {
    const value = JSON.parse(await readFile(diagnostics, "utf8"));
    return value.ready === true && value.shellContract === 2
      ? value
      : undefined;
  }, "the contract-2 WKWebView to become ready");
  const initialWrittenAt = (await stat(diagnostics)).mtimeMs;
  const initial = await fixture.health();
  const execute = await fixture.client();
  const targetBuildId = await fixture.candidate();

  const restartTarget = await waitFor(async () => {
    const status = await execute("updates.get");
    const client = status.clients?.find(
      (item: { surface?: string }) => item.surface === "native",
    );
    if (
      !client ||
      status.pendingHostId !== targetBuildId ||
      status.available?.host?.buildId !== targetBuildId
    )
      return undefined;
    return { generation: status.available.host.generation };
  }, "the native client and exact host candidate");

  await control(fixture.data, {
    type: "updates-restart",
    action: "approve",
    targetBuildId,
    generation: restartTarget.generation,
    mode: "now",
    confirm: true,
  });

  const replacement = await waitFor(async () => {
    const health = await fixture.health();
    return health.instanceId !== initial.instanceId &&
      health.hostBuildId === targetBuildId
      ? health
      : undefined;
  }, "the exact replacement host");

  const approval = await waitFor(async () => {
    const value = JSON.parse(
      await readFile(join(fixture.data, "updates/restart.json"), "utf8"),
    );
    return value.phase === "completed" ? value : undefined;
  }, "durable restart completion");

  const restored = await waitFor(async () => {
    const writtenAt = (await stat(diagnostics)).mtimeMs;
    const value = JSON.parse(await readFile(diagnostics, "utf8"));
    return writtenAt > initialWrittenAt &&
      value.ready === true &&
      value.shellContract === 2 &&
      value.origin === initialDiagnostic.origin
      ? value
      : undefined;
  }, "the same WKWebView shell to reconnect");

  await mkdir(resolve(".suri-local/diagnostics"), { recursive: true });
  await cp(
    diagnostics.replace(/\.json$/, ".png"),
    resolve(".suri-local/diagnostics/native-contract2-restart.png"),
  );
  const evidence = {
    schema: 1,
    passed: true,
    capturedAt: new Date().toISOString(),
    operationId: approval.operationId,
    operationPhase: approval.phase,
    profileId: approval.profileId,
    fromInstanceId: initial.instanceId,
    toInstanceId: replacement.instanceId,
    targetBuildId,
    hostBuildId: replacement.hostBuildId,
    shellContract: restored.shellContract,
    origin: restored.origin,
    sameOrigin: restored.origin === initialDiagnostic.origin,
    ready: restored.ready,
    path: restored.path,
  };
  await writeFile(
    resolve(".suri-local/diagnostics/native-contract2-restart.json"),
    JSON.stringify(evidence, null, 2) + "\n",
  );

  console.log(JSON.stringify(evidence));
} finally {
  shell.kill("SIGTERM");
  await delay(300);
  if (
    await fixture.health().then(
      () => true,
      () => false,
    )
  )
    await fixture.close();
}
