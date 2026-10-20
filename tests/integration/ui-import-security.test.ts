import { beforeAll, afterAll, describe, expect, it } from "vitest";
import {
  mkdtemp,
  mkdir,
  realpath,
  writeFile,
  rm,
  symlink,
  rename,
  readFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ImmutableArtifacts,
  checkoutIdentity,
  validatePrivateArtifact,
} from "../../apps/host/src/update-artifacts.js";
import {
  inventory,
  publishArtifact,
  updateCompatibility,
} from "../../scripts/build-manifests.mjs";
import { compileHelper } from "../../scripts/native-helper.mjs";
import { UpdateDiscovery } from "../../apps/host/src/update-discovery.js";
let root: string;
let helper: string;
beforeAll(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "suri-import-security-")));
  helper = join(root, "helper");
  compileHelper(helper, { flags: ["-Wall", "-Wextra", "-O2"] });
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const checkout = await mkdtemp(join(root, "checkout-"));
  const data = await mkdtemp(join(root, "data-"));
  await mkdir(join(checkout, "dist/apps/host/src"), { recursive: true });
  await writeFile(join(checkout, "dist/apps/host/src/cli.js"), "export {}");
  await writeFile(join(checkout, "package.json"), '{"name":"suri-pi"}');
  const stage = join(checkout, "stage");
  await mkdir(stage);
  await writeFile(join(stage, "index.html"), "<html></html>");
  await writeFile(join(stage, "entry.js"), "export {}");
  const candidate = await publishArtifact(join(checkout, ".build/ui"), stage, {
    schema: 1,
    kind: "ui",
    compatibility: updateCompatibility,
    entry: "entry.js",
    files: await inventory(stage),
  });
  return {
    checkout,
    candidate,
    identity: await checkoutIdentity(checkout),
    store: new ImmutableArtifacts(data, helper),
  };
}
describe("descriptor-anchored UI import", () => {
  it("discovers the published generation, caches retained bytes and rejects malformed pointers", async () => {
    const f = await fixture();
    const discovery = new UpdateDiscovery(f.store);
    const first = await discovery.reconcile(f.identity);
    expect(first.ui).toMatchObject({
      state: "verified",
      buildId: f.candidate.buildId,
      generation: 1,
    });
    expect(first.host).toEqual({ state: "none" });
    expect(await discovery.reconcile(f.identity)).toEqual(first);
    await writeFile(
      join(f.checkout, ".build/ui/latest.json"),
      '{"unexpected":"fixture-private-text"}',
    );
    const refused = await discovery.reconcile(f.identity);
    expect(refused.ui).toEqual({
      state: "rejected",
      buildId: null,
      code: "CANDIDATE_INTEGRITY",
    });
    expect(JSON.stringify(refused)).not.toContain("fixture-private-text");
  });
  it("never shares an in-flight discovery result across associations", async () => {
    const a = await fixture(),
      b = await fixture();
    await writeFile(join(b.checkout, ".build/ui/latest.json"), "invalid");
    const discovery = new UpdateDiscovery(a.store);
    const [valid, invalid] = await Promise.all([
      discovery.reconcile(a.identity),
      discovery.reconcile(b.identity),
    ]);
    expect(valid.ui.state).toBe("verified");
    expect(invalid.ui.state).toBe("rejected");
  });
  it("retains validated bytes independently from checkout", async () => {
    const f = await fixture();
    const imported = await f.store.import(
      f.identity,
      "ui",
      f.candidate.buildId,
    );
    await rm(f.checkout, { recursive: true });
    expect(
      (await validatePrivateArtifact(imported.path, "ui", f.candidate.buildId))
        .buildId,
    ).toBe(f.candidate.buildId);
    expect(await readFile(join(imported.path, "entry.js"), "utf8")).toBe(
      "export {}",
    );
  });
  it.each(["manifest.json", "entry.js"])(
    "rejects %s symlink without following it",
    async (name) => {
      const f = await fixture();
      await rename(join(f.candidate.path, name), join(f.checkout, "external"));
      await symlink(join(f.checkout, "external"), join(f.candidate.path, name));
      await expect(
        f.store.import(f.identity, "ui", f.candidate.buildId),
      ).rejects.toMatchObject({ code: "CANDIDATE_INTEGRITY" });
    },
  );
  it("rejects output root symlink and extra files", async () => {
    const f = await fixture();
    await writeFile(join(f.candidate.path, "extra"), "not listed");
    await expect(
      f.store.import(f.identity, "ui", f.candidate.buildId),
    ).rejects.toMatchObject({ code: "CANDIDATE_INTEGRITY" });
    // Isolate the ancestor-symlink boundary from the already-proven extra-file failure.
    await rm(join(f.candidate.path, "extra"));
    await rename(join(f.checkout, ".build"), join(f.checkout, "elsewhere"));
    await symlink(join(f.checkout, "elsewhere"), join(f.checkout, ".build"));
    await expect(
      f.store.import(f.identity, "ui", f.candidate.buildId),
    ).rejects.toMatchObject({ code: "CANDIDATE_INTEGRITY" });
  });
  it("rejects changed payload bytes under the same published identity", async () => {
    const f = await fixture();
    await writeFile(
      join(f.candidate.path, "entry.js"),
      "throw new Error('changed payload');",
    );
    await expect(
      f.store.import(f.identity, "ui", f.candidate.buildId),
    ).rejects.toMatchObject({ code: "CANDIDATE_INTEGRITY" });
  });
  it("rejects replacement checkout identity", async () => {
    const f = await fixture();
    await rename(f.checkout, f.checkout + "-old");
    await mkdir(f.checkout);
    await expect(
      f.store.import(f.identity, "ui", f.candidate.buildId),
    ).rejects.toMatchObject({ code: "CHECKOUT_CHANGED" });
  });
  it("serializes concurrent identical imports by atomic directory installation", async () => {
    const f = await fixture();
    const imports = await Promise.all([
      f.store.import(f.identity, "ui", f.candidate.buildId),
      f.store.import(f.identity, "ui", f.candidate.buildId),
    ]);
    expect(imports[0].path).toBe(imports[1].path);
  });
});
