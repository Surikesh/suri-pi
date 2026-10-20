import { randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { probe } from "../../packages/pi-adapter/src/index.js";
import {
  runtimeAcceptanceCases,
  validateRuntimeAcceptanceEvidence,
} from "../../apps/host/src/runtime-evidence.js";
import { RuntimeValidator } from "../../apps/host/src/runtime-validation.js";
import { Storage } from "../../apps/host/src/storage.js";

const roots: string[] = [];
afterEach(async () =>
  Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  ),
);

async function runtimeFixture(version = "0.85.1") {
  const root = await mkdtemp(join(tmpdir(), "suri-runtime-identity-"));
  roots.push(root);
  const packageRoot = join(
    root,
    "node_modules/@earendil-works/pi-coding-agent",
  );
  const executable = join(packageRoot, "dist/bundle/cli.js");
  await mkdir(join(packageRoot, "dist/bundle"), { recursive: true });
  await mkdir(join(packageRoot, "node_modules/dependency"), {
    recursive: true,
  });
  await mkdir(join(root, "node_modules/.bin"), { recursive: true });
  await writeFile(
    join(packageRoot, "package.json"),
    JSON.stringify({
      name: "@earendil-works/pi-coding-agent",
      version,
      bin: { pi: "dist/bundle/cli.js" },
    }),
  );
  await writeFile(
    join(packageRoot, "npm-shrinkwrap.json"),
    '{"lockfileVersion":3}\n',
  );
  await writeFile(
    join(packageRoot, "node_modules/dependency/package.json"),
    '{"name":"dependency","version":"1.0.0"}',
  );
  await writeFile(
    executable,
    `#!/usr/bin/env node\nif (process.argv.includes("--version")) console.log(${JSON.stringify(version)});\n`,
    { mode: 0o755 },
  );
  await chmod(executable, 0o755);
  const link = join(root, "node_modules/.bin/pi");
  await symlink(executable, link);
  return { root, packageRoot, executable, link };
}

function evidence(identity: Awaited<ReturnType<typeof probe>>) {
  return {
    schema: "suri.runtime-acceptance.v1",
    scope: "real-pi",
    producer: "suri-host-runtime-validation/v1",
    simulated: false,
    passed: true,
    version: identity.version,
    identity: identity.identity,
    executableSha256: identity.executableSha256,
    adapterIdentity: identity.adapterIdentity,
    evidenceId: randomUUID(),
    validatedAt: new Date().toISOString(),
    cases: Object.fromEntries(
      runtimeAcceptanceCases.map((name) => [name, true]),
    ),
  };
}

describe("runtime executable identity and promotion evidence", () => {
  test("binds the canonical declared entrypoint and full executable distribution", async () => {
    const item = await runtimeFixture();
    const first = await probe(item.link, "0.85.1");
    expect(first.executable).toBe(await realpath(item.executable));
    await writeFile(
      item.executable,
      '#!/usr/bin/env node\nconsole.log("0.85.1")\n// changed loader\n',
    );
    await chmod(item.executable, 0o755);
    const changed = await probe(item.link, "0.85.1");
    expect(changed.identity).not.toBe(first.identity);
    expect(changed.executableSha256).not.toBe(first.executableSha256);
  });

  test("rejects executables outside the declared package entry and unsupported versions", async () => {
    const item = await runtimeFixture();
    const other = join(item.packageRoot, "dist/other.js");
    await writeFile(other, '#!/usr/bin/env node\nconsole.log("0.85.1")\n', {
      mode: 0o755,
    });
    await expect(probe(other, "0.85.1")).rejects.toMatchObject({
      code: "RUNTIME_UNSUPPORTED",
    });
    await expect(probe(item.link, "9.9.9")).rejects.toMatchObject({
      code: "RUNTIME_UNSUPPORTED",
    });
  });

  test("requires host-owned exact complete non-simulated evidence", async () => {
    const identity = await probe((await runtimeFixture()).link, "0.85.1");
    const valid = evidence(identity);
    expect(
      validateRuntimeAcceptanceEvidence(valid, identity, true),
    ).toMatchObject({ evidenceId: valid.evidenceId });
    for (const forged of [
      { passed: true },
      { ...valid, simulated: true },
      { ...valid, identity: "stale" },
      { ...valid, adapterIdentity: "wrong" },
      { ...valid, evidenceId: "" },
      { ...valid, validatedAt: "1900-01-01T00:00:00.000Z" },
      { ...valid, validatedAt: "not-a-date" },
      { ...valid, cases: { ...valid.cases, cancel: false } },
      { ...valid, cases: { ...valid.cases, unexpected: true } },
    ])
      expect(() =>
        validateRuntimeAcceptanceEvidence(forged, identity, true),
      ).toThrow(expect.objectContaining({ code: "RUNTIME_EVIDENCE_INVALID" }));
    expect(() =>
      validateRuntimeAcceptanceEvidence(valid, identity, false),
    ).toThrow(expect.objectContaining({ code: "RUNTIME_EVIDENCE_UNTRUSTED" }));
  });

  test("revalidates a persisted legacy identity through owned acceptance without replacing its catalog id", async () => {
    const item = await runtimeFixture();
    const identity = await probe(item.link, "0.85.1");
    const dataRoot = await mkdtemp(
      join(tmpdir(), "suri-legacy-runtime-store-"),
    );
    roots.push(dataRoot);
    const store = new Storage(dataRoot);
    try {
      store.put("runtime", {
        id: "legacy-runtime",
        executable: item.link,
        version: "0.85.1",
        identity: "legacy-v1-artifact-identity",
        status: "verified",
        evidenceId: "legacy-evidence",
        revision: 3,
      });
      const accepted = evidence(identity);
      const validator = new RuntimeValidator(async () => accepted as any);
      const promoted = await validator.validateAndPromote(
        store,
        "legacy-runtime",
        {
          provider: "fixture-provider",
          model: "fixture-model",
          agentDir: dataRoot,
        },
      );
      expect(promoted).toMatchObject({
        id: "legacy-runtime",
        identity: identity.identity,
        executableSha256: identity.executableSha256,
        status: "verified",
        evidenceId: accepted.evidenceId,
        validatedAt: accepted.validatedAt,
        revision: 4,
      });
      expect(store.get("runtime", "legacy-runtime")).toEqual(promoted);
      const retained = JSON.parse(
        await readFile(
          join(dataRoot, "runtime-evidence", `${accepted.evidenceId}.json`),
          "utf8",
        ),
      );
      expect(retained).toEqual(accepted);
    } finally {
      store.close();
    }
  });

  test("does not alter a legacy runtime when owned acceptance evidence is invalid", async () => {
    const item = await runtimeFixture();
    const identity = await probe(item.link, "0.85.1");
    const dataRoot = await mkdtemp(
      join(tmpdir(), "suri-rejected-runtime-store-"),
    );
    roots.push(dataRoot);
    const store = new Storage(dataRoot);
    const legacy = {
      id: "legacy-runtime",
      executable: item.link,
      version: "0.85.1",
      identity: "legacy-v1-artifact-identity",
      status: "verified",
      evidenceId: "legacy-evidence",
      revision: 3,
    };
    try {
      store.put("runtime", legacy);
      const invalid = { ...evidence(identity), identity: "forged" };
      const validator = new RuntimeValidator(async () => invalid as any);
      await expect(
        validator.validateAndPromote(store, "legacy-runtime", {
          provider: "fixture-provider",
          model: "fixture-model",
          agentDir: dataRoot,
        }),
      ).rejects.toMatchObject({ code: "RUNTIME_EVIDENCE_INVALID" });
      expect(store.get("runtime", "legacy-runtime")).toEqual(legacy);
    } finally {
      store.close();
    }
  });
});
