import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  cp,
  chmod,
  realpath,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { compileHelper } from "../../scripts/native-helper.mjs";
import { atomicJson, digest } from "../../scripts/build-manifests.mjs";
import {
  canonicalJson,
  UiIdentitySchema,
} from "../../packages/protocol/src/updates.js";
import { startHost } from "../../apps/host/src/host.js";
import { control } from "../../apps/host/src/cli.js";

export async function updateFixture(productionAssets?: string) {
  const root = await mkdtemp(join(tmpdir(), "suri-modern-update-"));
  const checkout = join(root, "checkout");
  await mkdir(join(checkout, "dist/apps/host/src"), { recursive: true });
  await writeFile(join(checkout, "package.json"), '{"name":"suri-pi"}');
  await writeFile(
    join(checkout, "dist/apps/host/src/cli.js"),
    "// fixture identity marker",
  );
  const helper = join(root, "helper");
  compileHelper(helper, { flags: ["-O2"] });
  let generation = 0;
  async function build(label: string, broken = false) {
    if (productionAssets && !broken) {
      const original = JSON.parse(
        await readFile(join(productionAssets, "manifest.json"), "utf8"),
      );
      const entry = original.identity.entry;
      const bytes =
        (await readFile(join(productionAssets, entry), "utf8")) +
        `\n/* isolated update fixture: ${label} */\n`;
      const identity = UiIdentitySchema.parse({
        ...original.identity,
        files: original.identity.files.map((file: { path: string }) =>
          file.path === entry
            ? {
                ...file,
                bytes: Buffer.byteLength(bytes),
                sha256: digest(bytes),
              }
            : file,
        ),
      });
      const id = digest(canonicalJson(identity));
      const path = join(checkout, ".build/ui", id);
      await cp(productionAssets, path, { recursive: true });
      await writeFile(join(path, entry), bytes);
      await atomicJson(join(path, "manifest.json"), {
        buildId: id,
        createdAt: new Date().toISOString(),
        identity,
      });
      await atomicJson(join(path, "ready.json"), { schema: 1, buildId: id });
      await atomicJson(join(checkout, ".build/ui/latest.json"), {
        schema: 1,
        generation: ++generation,
        buildId: id,
      });
      return { id, path };
    }
    const bytes = broken
      ? "throw Error('synthetic entry failure')"
      : `document.getElementById('root').innerHTML='<main class="shell"><h1>${label}</h1><textarea aria-label="Draft"></textarea></main>';window.suriReady=true;window.suriRestore=async c=>{if(c)document.querySelector('textarea').value=c.draft.text};`;
    const html = "<!doctype html><div id=root></div>";
    const identity = UiIdentitySchema.parse({
      schema: 1,
      kind: "ui",
      compatibility: {
        protocol: 1,
        hostMin: 2,
        hostMax: 2,
        checkpoint: 1,
        shellMin: 2,
      },
      entry: "entry.js",
      files: [
        {
          path: "entry.js",
          sha256: digest(bytes),
          bytes: Buffer.byteLength(bytes),
          executable: false,
        },
        {
          path: "index.html",
          sha256: digest(html),
          bytes: Buffer.byteLength(html),
          executable: false,
        },
      ],
    });
    const id = digest(canonicalJson(identity));
    const path = join(checkout, ".build/ui", id);
    await mkdir(path, { recursive: true });
    await writeFile(join(path, "entry.js"), bytes);
    await writeFile(join(path, "index.html"), html);
    await atomicJson(join(path, "manifest.json"), {
      buildId: id,
      createdAt: new Date().toISOString(),
      identity,
    });
    await atomicJson(join(path, "ready.json"), { schema: 1, buildId: id });
    await atomicJson(join(checkout, ".build/ui/latest.json"), {
      schema: 1,
      generation: ++generation,
      buildId: id,
    });
    return { id, path };
  }
  const baseline = await build("Baseline A");
  const data = join(root, "data");
  const host = await startHost({
    root: data,
    assets: baseline.path,
    helper,
    uiCheckout: checkout,
    simulated: true,
    validation: true,
    modernUpdates: true,
  });
  return {
    root,
    checkout,
    baseline,
    host,
    build,
    async bootstrap() {
      return control(data, { type: "bootstrap" });
    },
    async health() {
      return control(data, { type: "health" });
    },
    async rendezvous(clientInstanceId: string) {
      return control(data, { type: "browser-rendezvous", clientInstanceId });
    },
    async execute(
      type: string,
      payload = {},
      auth = randomUUID(),
      sessionId?: string,
    ) {
      return host.execute(
        {
          v: 1,
          id: randomUUID(),
          createdAt: new Date().toISOString(),
          type,
          payload,
          sessionId,
        },
        auth,
      );
    },
    async seed() {
      const call = async (type: string, payload: Record<string, unknown>) => {
        const receipt = await host.execute(
          {
            v: 1,
            id: randomUUID(),
            createdAt: new Date().toISOString(),
            type,
            payload,
          },
          "fixture-client",
        );
        if (receipt.status === "rejected") throw Error(receipt.error?.message);
        return receipt.result!;
      };
      await call("project.add", {
        directoryGrantId: (
          await control(data, {
            type: "grant",
            kind: "directory",
            path: await realpath(checkout),
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
      const rt = await call("runtime.register", {
        executableGrantId: (
          await control(data, {
            type: "grant",
            kind: "executable",
            path: await realpath(executable),
          })
        ).grantId,
        expectedVersion: "0.85.1",
      });
      return call("session.create", {
        workspaceId: host.store.list("workspace")[0].id,
        runtimeId: rt.id,
      });
    },
    async close() {
      await host.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}
