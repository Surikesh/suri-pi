import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, test } from "vitest";
import {
  claimLegacyMigration,
  createLegacyMigration,
  finishLegacyMigration,
  markLegacyMigrationReplacementVerified,
  markLegacyMigrationSourceStopped,
  requestLegacyMigrationAdmission,
  type LegacyMigrationApproval,
} from "../../apps/host/src/legacy-migration.js";

const helper = resolve("dist/native/suri-helper");
let root = "";
afterEach(async () => root && rm(root, { recursive: true, force: true }));
const approval = (): LegacyMigrationApproval => ({
  schema: 1,
  state: "pending",
  operationId: randomUUID(),
  expectedPid: 123,
  expectedInstanceId: randomUUID(),
  profileId: randomUUID(),
  origin: "http://127.0.0.1:43123",
  sourceBuildId: null,
  sourceProvenance: "legacy-unverified",
  targetBuildId: "a".repeat(64),
  uiBuildId: "b".repeat(64),
  expiresAt: Date.now() + 120_000,
});

async function externalLock() {
  const child = spawn(
    helper,
    ["lock", join(root, "updates/legacy-migration.lock")],
    {
      stdio: ["pipe", "pipe", "ignore"],
    },
  );
  await new Promise<void>((resolveReady, reject) => {
    child.stdout.once("data", () => resolveReady());
    child.once("error", reject);
    child.once("exit", (code) => code && reject(Error(`lock exited ${code}`)));
  });
  return child;
}

test("persisted approval is the one-shot authority for exact migration tuple", async () => {
  root = await mkdtemp(join(tmpdir(), "legacy-migration-"));
  const first = approval();
  await createLegacyMigration(root, first, helper);
  await expect(
    createLegacyMigration(
      root,
      { ...approval(), targetBuildId: "c".repeat(64) },
      helper,
    ),
  ).rejects.toMatchObject({ code: "MIGRATION_ALREADY_PENDING" });
  await expect(
    claimLegacyMigration(root, { ...first, uiBuildId: "d".repeat(64) }, helper),
  ).rejects.toMatchObject({ code: "MIGRATION_APPROVAL_MISMATCH" });
  const requested = await requestLegacyMigrationAdmission(
    root,
    first.operationId,
    helper,
  );
  await claimLegacyMigration(root, requested, helper);
  await expect(
    claimLegacyMigration(root, requested, helper),
  ).resolves.toMatchObject({
    state: "admitted",
  });
  const replacement = { pid: 456, instanceId: randomUUID() };
  await markLegacyMigrationSourceStopped(root, first.operationId, helper);
  await markLegacyMigrationReplacementVerified(
    root,
    first.operationId,
    replacement,
    helper,
  );
  await finishLegacyMigration(
    root,
    first.operationId,
    "succeeded",
    helper,
    replacement,
  );
  const disk = JSON.parse(
    await readFile(join(root, "updates/legacy-migration.json"), "utf8"),
  );
  expect(disk).toMatchObject({
    state: "succeeded",
    operationId: first.operationId,
    replacementPid: replacement.pid,
    replacementInstanceId: replacement.instanceId,
  });
  await expect(
    finishLegacyMigration(root, first.operationId, "failed", helper),
  ).rejects.toMatchObject({ code: "MIGRATION_APPROVAL_MISMATCH" });
});

test("an expired admitted operation stays non-overwritable and remains exactly recoverable", async () => {
  root = await mkdtemp(join(tmpdir(), "legacy-migration-recovery-"));
  const first = approval();
  await createLegacyMigration(root, first, helper);
  const requested = await requestLegacyMigrationAdmission(
    root,
    first.operationId,
    helper,
  );
  await claimLegacyMigration(root, requested, helper);
  const path = join(root, "updates/legacy-migration.json");
  const admitted = JSON.parse(await readFile(path, "utf8"));
  await writeFile(
    path,
    JSON.stringify({ ...admitted, expiresAt: Date.now() - 1 }),
  );
  await expect(
    createLegacyMigration(root, approval(), helper),
  ).rejects.toMatchObject({
    code: "MIGRATION_ALREADY_PENDING",
  });
  await markLegacyMigrationSourceStopped(root, first.operationId, helper);
  const replacement = { pid: 789, instanceId: randomUUID() };
  await markLegacyMigrationReplacementVerified(
    root,
    first.operationId,
    replacement,
    helper,
  );
  await expect(
    finishLegacyMigration(
      root,
      first.operationId,
      "succeeded",
      helper,
      replacement,
    ),
  ).resolves.toMatchObject({ state: "succeeded", replacementPid: 789 });
});

test("kernel lock rejects two contenders and releases only when its owner exits", async () => {
  root = await mkdtemp(join(tmpdir(), "legacy-migration-lock-"));
  await import("node:fs/promises").then(({ mkdir }) =>
    mkdir(join(root, "updates"), { recursive: true }),
  );
  const owner = await externalLock();
  const one = approval();
  const two = approval();
  await expect(
    Promise.allSettled([
      createLegacyMigration(root, one, helper),
      createLegacyMigration(root, two, helper),
    ]),
  ).resolves.toSatisfy((results) =>
    results.every(
      (result: PromiseSettledResult<LegacyMigrationApproval>) =>
        result.status === "rejected" &&
        (result.reason as { code?: string }).code ===
          "MIGRATION_ALREADY_PENDING",
    ),
  );
  owner.stdin.end();
  await new Promise<void>((done) => owner.once("exit", () => done()));
  await createLegacyMigration(root, one, helper);
  const requested = await requestLegacyMigrationAdmission(
    root,
    one.operationId,
    helper,
  );
  await claimLegacyMigration(root, requested, helper);
  await markLegacyMigrationSourceStopped(root, one.operationId, helper);
});
