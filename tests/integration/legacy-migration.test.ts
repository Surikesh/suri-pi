import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import {
  cp,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
  realpath,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, test } from "vitest";
import { control } from "../../apps/host/src/cli.js";
import {
  ImmutableArtifacts,
  checkoutIdentity,
} from "../../apps/host/src/update-artifacts.js";
import { UpdateStateStore } from "../../apps/host/src/update-state.js";

let root = "";
const disposablePids = new Set<number>();
const delay = (ms: number) => new Promise((done) => setTimeout(done, ms));
async function stopDisposable(data: string) {
  let health: any;
  try {
    health = await control(data, { type: "health" });
    if (Number.isSafeInteger(health.pid)) disposablePids.add(health.pid);
  } catch {}
  const launch = await readFile(join(data, "run/update-launch.json"), "utf8")
    .then(JSON.parse)
    .catch(() => null);
  if (Number.isSafeInteger(launch?.pid)) disposablePids.add(launch.pid);
  if (!health) return;
  const grant = await control(data, { type: "bootstrap" });
  const boot = await fetch(grant.origin + "/v1/bootstrap", {
    method: "POST",
    headers: { Origin: grant.origin, "Content-Type": "application/json" },
    body: JSON.stringify({ nonce: grant.nonce }),
  });
  const auth = (await boot.json()) as { csrf: string };
  const response = await fetch(grant.origin + "/v1/commands", {
    method: "POST",
    headers: {
      Origin: grant.origin,
      "Content-Type": "application/json",
      Cookie: boot.headers.get("set-cookie")!.split(";")[0],
      "X-Suri-Csrf": auth.csrf,
    },
    body: JSON.stringify({
      v: 1,
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      type: "host.shutdown",
      payload: {},
    }),
  });
  if (!response.ok) throw Error("DISPOSABLE_SHUTDOWN_REFUSED");
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      await control(data, { type: "health" });
    } catch {
      return;
    }
    await delay(50);
  }
  throw Error("DISPOSABLE_HOST_LEAKED");
}
afterEach(async () => {
  if (!root) return;
  const data = join(root, "profile");
  await stopDisposable(data);
  for (const pid of disposablePids) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {}
  }
  for (let attempt = 0; attempt < 100 && disposablePids.size; attempt++) {
    for (const pid of disposablePids) {
      try {
        process.kill(pid, 0);
      } catch {
        disposablePids.delete(pid);
      }
    }
    if (disposablePids.size) await delay(50);
  }
  if (disposablePids.size)
    throw Error(`DISPOSABLE_HOST_LEAKED:${[...disposablePids].join(",")}`);
  await rm(root, { recursive: true, force: true });
  root = "";
});

async function port() {
  const server = createServer();
  await new Promise<void>((done, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", done);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw Error("PORT_UNAVAILABLE");
  await new Promise<void>((done) => server.close(() => done()));
  return address.port;
}

async function waitHealth(data: string) {
  for (let attempt = 0; attempt < 150; attempt++) {
    try {
      return await control(data, { type: "health" });
    } catch {}
    await delay(100);
  }
  throw Error("HOST_NOT_READY");
}

// macOS-only: the spawned CLI host runs the product platform preflight, which rejects non-macOS with UNSUPPORTED_PLATFORM.
test
  .skipIf(process.platform !== "darwin")
  .each([
    "claim-response-loss",
    "exit-after-admission",
    "exit-after-source-stop",
    "exit-after-replacement-verified",
  ])(
  "legacy migration recovers %s and proves exact spawned contract-2 host",
  async (failure) => {
    root = await realpath(await mkdtemp(join(tmpdir(), "legacy-live-")));
    const data = join(root, "profile"),
      checkout = join(root, "checkout");
    await mkdir(join(checkout, "dist/apps/host/src"), { recursive: true });
    await writeFile(join(checkout, "package.json"), '{"name":"suri-pi"}');
    await writeFile(join(checkout, "dist/apps/host/src/cli.js"), "// fixture");
    const hostLatest = JSON.parse(
      await readFile(resolve(".build/host/latest.json"), "utf8"),
    );
    const uiLatest = JSON.parse(
      await readFile(resolve(".build/ui/latest.json"), "utf8"),
    );
    await cp(
      resolve(".build/host", hostLatest.buildId),
      join(checkout, ".build/host", hostLatest.buildId),
      { recursive: true },
    );
    await cp(
      resolve(".build/ui", uiLatest.buildId),
      join(checkout, ".build/ui", uiLatest.buildId),
      { recursive: true },
    );
    const association = await checkoutIdentity(checkout);
    const state = await UpdateStateStore.load(data);
    await state.change(0, (draft) => {
      draft.channel = "development";
      draft.association = association;
    });
    const artifacts = new ImmutableArtifacts(
      data,
      resolve(".build/host", hostLatest.buildId, "dist/native/suri-helper"),
    );
    const image = await artifacts.import(
      association,
      "host",
      hostLatest.buildId,
    );
    const ui = await artifacts.import(association, "ui", uiLatest.buildId);
    const selectedPort = await port();
    await mkdir(join(data, "run"), { recursive: true });
    const origin = `http://127.0.0.1:${selectedPort}`;
    await writeFile(
      join(data, "run/endpoint.json"),
      JSON.stringify({ origin }),
    );
    const environment = {
      ...process.env,
      SURI_DATA_DIR: data,
      SURI_PORT: String(selectedPort),
      SURI_ASSETS_DIR: ui.path,
      SURI_SIMULATED: "1",
      SURI_VALIDATE: "1",
      ...(failure === "claim-response-loss"
        ? { SURI_TEST_DROP_MIGRATION_ADMISSION_RESPONSE: "1" }
        : {}),
    };
    const legacy = spawn(
      process.execPath,
      [join(image.path, "dist/apps/host/src/cli.js"), "serve"],
      { env: environment, stdio: "ignore" },
    );
    if (legacy.pid) disposablePids.add(legacy.pid);
    const old = await waitHealth(data);
    expect(old).toMatchObject({ uiContract: 1, hostBuildId: null });
    const command = [
      join(image.path, "dist/apps/host/src/cli.js"),
      "updates",
      "migrate",
      hostLatest.buildId,
      uiLatest.buildId,
      "--confirm",
    ];
    if (failure !== "claim-response-loss") {
      const interrupted = spawnSync(process.execPath, command, {
        env: {
          ...environment,
          SURI_TEST_EXIT_MIGRATION_AT:
            failure === "exit-after-admission"
              ? "admitted"
              : failure === "exit-after-source-stop"
                ? "source-stopped"
                : "replacement-verified",
        },
        encoding: "utf8",
        timeout: 30_000,
      });
      expect(
        interrupted.status,
        interrupted.stderr +
          "\n" +
          (await readFile(
            join(data, "updates/legacy-migration.json"),
            "utf8",
          ).catch(() => "no approval")),
      ).toBe(86);
    }
    const migrated = spawnSync(process.execPath, command, {
      env: environment,
      encoding: "utf8",
      timeout: 30_000,
    });
    expect(
      migrated.status,
      migrated.stderr +
        "\n" +
        (await readFile(
          join(data, "updates/legacy-migration.json"),
          "utf8",
        ).catch(() => "no approval")),
    ).toBe(0);
    const result = JSON.parse(migrated.stdout.trim());
    expect(result).toMatchObject({
      migrated: true,
      fromInstanceId: old.instanceId,
      hostBuildId: hostLatest.buildId,
      uiContract: 2,
      origin,
    });
    const next = await control(data, { type: "health" });
    expect(next).toMatchObject({
      instanceId: result.instanceId,
      pid: expect.any(Number),
      hostBuildId: hostLatest.buildId,
      uiBuildId: uiLatest.buildId,
      uiContract: 2,
    });
    expect(next.instanceId).not.toBe(old.instanceId);
    const approval = JSON.parse(
      await readFile(join(data, "updates/legacy-migration.json"), "utf8"),
    );
    expect(approval).toMatchObject({
      state: "succeeded",
      operationId: result.operationId,
      replacementPid: next.pid,
      replacementInstanceId: next.instanceId,
    });
    const repeated = spawnSync(process.execPath, command, {
      env: environment,
      encoding: "utf8",
      timeout: 30_000,
    });
    expect(repeated.status, repeated.stderr).toBe(0);
    expect(JSON.parse(repeated.stdout)).toMatchObject({
      migrated: true,
      operationId: result.operationId,
      instanceId: next.instanceId,
    });
    expect(
      legacy.exitCode === 0 || legacy.killed || legacy.exitCode === null,
    ).toBe(true);
    await control(data, { type: "health" });
  },
);
