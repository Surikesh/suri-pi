import { spawn } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  cp,
  readFile,
  writeFile,
  rm,
  realpath,
  chmod,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { atomicJson, digest } from "../../scripts/build-manifests.mjs";
import { canonicalJson } from "../../packages/protocol/src/updates.js";
import {
  ImmutableArtifacts,
  checkoutIdentity,
} from "../../apps/host/src/update-artifacts.js";
import { UpdateStateStore } from "../../apps/host/src/update-state.js";
import { control } from "../../apps/host/src/cli.js";

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
export async function restartFixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "sr-")));
  const checkout = join(root, "checkout"),
    data = join(root, "profile");
  await mkdir(join(checkout, "dist/apps/host/src"), { recursive: true });
  await writeFile(join(checkout, "package.json"), '{"name":"suri-pi"}');
  await writeFile(
    join(checkout, "dist/apps/host/src/cli.js"),
    "// trusted fixture marker",
  );
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
  await atomicJson(join(checkout, ".build/host/latest.json"), {
    schema: 1,
    generation: 1,
    buildId: hostLatest.buildId,
  });
  await atomicJson(join(checkout, ".build/ui/latest.json"), {
    schema: 1,
    generation: 1,
    buildId: uiLatest.buildId,
  });
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
  const image = await artifacts.import(association, "host", hostLatest.buildId);
  const ui = await artifacts.import(association, "ui", uiLatest.buildId);
  const reservation = createServer();
  await new Promise<void>((done, reject) => {
    reservation.once("error", reject);
    reservation.listen(0, "127.0.0.1", done);
  });
  const address = reservation.address();
  if (!address || typeof address === "string") throw Error("PORT_UNAVAILABLE");
  await new Promise<void>((done, reject) =>
    reservation.close((error) => (error ? reject(error) : done())),
  );
  await mkdir(join(data, "run"), { recursive: true });
  await writeFile(
    join(data, "run/endpoint.json"),
    JSON.stringify({ origin: `http://127.0.0.1:${address.port}` }),
  );
  const first = spawn(
    process.execPath,
    [
      join(image.path, "dist/apps/host/src/cli.js"),
      "updates",
      "start-retained",
      hostLatest.buildId,
      uiLatest.buildId,
      "--confirm",
    ],
    {
      cwd: data,
      env: {
        ...process.env,
        SURI_DATA_DIR: data,
        SURI_ASSETS_DIR: ui.path,
        SURI_SIMULATED: "1",
        SURI_VALIDATE: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let firstOutput = "";
  first.stdout.on("data", (chunk) => {
    firstOutput += chunk.toString();
  });
  first.stderr.on("data", (chunk) => {
    firstOutput += chunk.toString();
  });
  const firstExited = new Promise<number | null>((resolve) =>
    first.once("exit", resolve),
  );
  let health;
  for (let i = 0; i < 100; i++) {
    try {
      health = await control(data, { type: "health" });
      break;
    } catch {}
    if (first.exitCode !== null)
      throw Error(
        "Retained fixture failed: " +
          (await readFile(join(data, "run/update-launch.json"), "utf8").catch(
            () => firstOutput.trim() || `exit=${first.exitCode}`,
          )),
      );
    await delay(100);
  }
  if (!health?.instanceId) throw Error("Retained fixture did not become ready");
  if ((await firstExited) !== 0)
    throw Error("Retained bootstrap CLI did not complete authentication");
  const bootstrap = () => control(data, { type: "bootstrap" });
  async function client() {
    const grant = await bootstrap();
    const response = await fetch(grant.origin + "/v1/bootstrap", {
      method: "POST",
      headers: { Origin: grant.origin, "Content-Type": "application/json" },
      body: JSON.stringify({ nonce: grant.nonce }),
    });
    const auth = (await response.json()) as { csrf: string };
    const cookie = response.headers.get("set-cookie")!.split(";")[0];
    return async (
      type: string,
      payload: Record<string, unknown> = {},
      sessionId?: string,
    ) => {
      const response = await fetch(grant.origin + "/v1/commands", {
        method: "POST",
        headers: {
          Origin: grant.origin,
          "Content-Type": "application/json",
          Cookie: cookie,
          "X-Suri-Csrf": auth.csrf,
        },
        body: JSON.stringify({
          v: 1,
          id: randomUUID(),
          createdAt: new Date().toISOString(),
          type,
          payload,
          sessionId,
        }),
      });
      const receipt = (await response.json()) as {
        status: string;
        result?: any;
        error?: { code: string };
      };
      if (!["completed", "accepted"].includes(receipt.status))
        throw Object.assign(Error(receipt.error?.code), {
          code: receipt.error?.code,
        });
      return receipt.result;
    };
  }
  async function stop() {
    const execute = await client();
    for (let i = 0; i < 20; i++) {
      try {
        await execute("host.shutdown");
        break;
      } catch (error) {
        if ((error as { code?: string }).code !== "HOST_BUSY") throw error;
        await delay(100);
      }
    }
    for (let i = 0; i < 100; i++) {
      try {
        await control(data, { type: "health" });
      } catch {
        return;
      }
      await delay(100);
    }
    throw Error("Retained fixture did not drain; retained at " + root);
  }
  return {
    root,
    data,
    checkout,
    initial: health,
    bootstrap,
    client,
    stop,
    async health() {
      return control(data, { type: "health" });
    },
    async seed() {
      const execute = await client();
      await execute("project.add", {
        directoryGrantId: (
          await control(data, {
            type: "grant",
            kind: "directory",
            path: checkout,
          })
        ).grantId,
      });
      const runtime = join(root, "fake-pi");
      await mkdir(join(runtime, "dist"), { recursive: true });
      await writeFile(
        join(runtime, "package.json"),
        JSON.stringify({
          name: "@earendil-works/pi-coding-agent",
          version: "0.85.1",
          type: "module",
        }),
      );
      const executable = join(runtime, "dist/cli.mjs");
      await cp(resolve("tests/fixtures/fake-pi.mjs"), executable);
      await chmod(executable, 0o755);
      const rt = await execute("runtime.register", {
        executableGrantId: (
          await control(data, {
            type: "grant",
            kind: "executable",
            path: executable,
          })
        ).grantId,
        expectedVersion: "0.85.1",
      });
      const catalog = await execute("catalog.get");
      return execute("session.create", {
        workspaceId: catalog.workspaces[0].id,
        runtimeId: rt.id,
      });
    },
    async candidate(failImport = false) {
      const source = join(checkout, ".build/host", hostLatest.buildId);
      const manifest = JSON.parse(
        await readFile(join(source, "manifest.json"), "utf8"),
      );
      const path = "dist/packages/pi-adapter/src/index.js";
      const bytes =
        (await readFile(join(source, path), "utf8")) +
        (failImport
          ? "\nthrow new Error('FIXTURE_TARGET_IMPORT_FAILURE');\n"
          : "\n// isolated adapter executable change\n");
      manifest.identity.files = manifest.identity.files.map(
        (file: { path: string }) =>
          file.path === path
            ? {
                ...file,
                bytes: Buffer.byteLength(bytes),
                sha256: digest(bytes),
              }
            : file,
      );
      manifest.identity.adapterId = digest(
        canonicalJson(
          manifest.identity.files.filter((file: { path: string }) =>
            file.path.startsWith("dist/packages/pi-adapter/"),
          ),
        ),
      );
      manifest.buildId = digest(canonicalJson(manifest.identity));
      const target = join(checkout, ".build/host", manifest.buildId);
      await cp(source, target, { recursive: true });
      await writeFile(join(target, path), bytes);
      await atomicJson(join(target, "manifest.json"), manifest);
      await atomicJson(join(target, "ready.json"), {
        schema: 1,
        buildId: manifest.buildId,
      });
      await atomicJson(join(checkout, ".build/host/latest.json"), {
        schema: 1,
        generation: 2,
        buildId: manifest.buildId,
      });
      return manifest.buildId as string;
    },
    async close() {
      await stop();
      await rm(root, { recursive: true, force: true });
    },
    async forceCloseOwned() {
      const current = await control(data, { type: "health" }).catch(() => null);
      if (current) {
        if (
          !Number.isSafeInteger(current.pid) ||
          current.pid <= 1 ||
          !root.startsWith((await realpath(tmpdir())) + sep)
        )
          throw Error("FIXTURE_PROCESS_OWNERSHIP_UNPROVEN");
        process.kill(current.pid, "SIGTERM");
        for (let i = 0; i < 100; i++) {
          if (!(await control(data, { type: "health" }).catch(() => null)))
            break;
          await delay(100);
        }
        if (await control(data, { type: "health" }).catch(() => null))
          throw Error("FIXTURE_PROCESS_DID_NOT_STOP");
      }
      await rm(root, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 100,
      });
    },
  };
}
