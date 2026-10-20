import type { ChildProcess } from "node:child_process";
import { mkdir, open } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { SuriError } from "../../../packages/protocol/src/index.js";
import { acquireLock } from "./resource-lock.js";
import { writeUpdateFile } from "./update-state.js";
import { BuildIdSchema } from "../../../packages/protocol/src/updates.js";

const ActiveStates = [
  "pending",
  "admission-requested",
  "admitted",
  "source-stopped",
  "replacement-verified",
] as const;
const Approval = z.strictObject({
  schema: z.literal(1),
  operationId: z.uuid(),
  state: z.enum([...ActiveStates, "succeeded", "failed"]),
  expectedPid: z.number().int().positive(),
  expectedInstanceId: z.uuid(),
  profileId: z.uuid(),
  origin: z.string().url(),
  sourceBuildId: BuildIdSchema.nullable(),
  sourceProvenance: z.string().min(1).max(80),
  targetBuildId: BuildIdSchema,
  uiBuildId: BuildIdSchema,
  expiresAt: z.number().int(),
  admissionRequestedAt: z.number().int().optional(),
  admittedAt: z.number().int().optional(),
  sourceStoppedAt: z.number().int().optional(),
  replacementVerifiedAt: z.number().int().optional(),
  finishedAt: z.number().int().optional(),
  failureCode: z
    .string()
    .regex(/^[A-Z_]{1,80}$/)
    .optional(),
  replacementPid: z.number().int().positive().optional(),
  replacementInstanceId: z.uuid().optional(),
});
export type LegacyMigrationApproval = z.infer<typeof Approval>;
const fileFor = (root: string) => join(root, "updates/legacy-migration.json");
const lockFor = (root: string) => join(root, "updates/legacy-migration.lock");
const runnerLockFor = (root: string) =>
  join(root, "updates/legacy-migration-runner.lock");

async function read(root: string) {
  try {
    const fd = await open(
      fileFor(root),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      const stat = await fd.stat();
      if (!stat.isFile() || stat.size > 64 * 1024) throw Error();
      const value = JSON.parse(await fd.readFile("utf8"));
      // Upgrade the former ambiguous claimed state conservatively. It proves
      // admission, but not source stop or replacement launch.
      if (value?.state === "claimed") {
        value.state = "admitted";
        value.admittedAt = value.claimedAt;
        delete value.claimedAt;
      }
      return Approval.parse(value);
    } finally {
      await fd.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return null;
    throw new SuriError(
      "MIGRATION_APPROVAL_INVALID",
      "Migration approval evidence is invalid.",
    );
  }
}

async function release(lock: ChildProcess) {
  lock.stdin?.end();
  if (lock.exitCode === null)
    await new Promise<void>((resolve) => lock.once("exit", () => resolve()));
}

async function locked<T>(
  root: string,
  helper: string,
  path: string,
  busyCode: string,
  action: () => Promise<T>,
): Promise<T> {
  await mkdir(join(root, "updates"), { recursive: true, mode: 0o700 });
  let lock: ChildProcess;
  try {
    lock = await acquireLock(helper, path);
  } catch {
    throw new SuriError(
      busyCode,
      "Another migration operation owns this boundary.",
    );
  }
  try {
    return await action();
  } finally {
    await release(lock);
  }
}

function stateLocked<T>(
  root: string,
  helper: string,
  action: () => Promise<T>,
) {
  return locked(
    root,
    helper,
    lockFor(root),
    "MIGRATION_ALREADY_PENDING",
    action,
  );
}

export function runLegacyMigrationExclusive<T>(
  root: string,
  helper: string,
  action: () => Promise<T>,
) {
  return locked(
    root,
    helper,
    runnerLockFor(root),
    "MIGRATION_ALREADY_RUNNING",
    action,
  );
}

function sameTuple(a: LegacyMigrationApproval, b: LegacyMigrationApproval) {
  return (
    a.operationId === b.operationId &&
    a.expectedPid === b.expectedPid &&
    a.expectedInstanceId === b.expectedInstanceId &&
    a.profileId === b.profileId &&
    a.origin === b.origin &&
    a.sourceBuildId === b.sourceBuildId &&
    a.sourceProvenance === b.sourceProvenance &&
    a.targetBuildId === b.targetBuildId &&
    a.uiBuildId === b.uiBuildId &&
    a.expiresAt === b.expiresAt
  );
}

export async function readLegacyMigration(root: string) {
  return read(root);
}

export async function createLegacyMigration(
  root: string,
  approval: LegacyMigrationApproval,
  helper: string,
) {
  return stateLocked(root, helper, async () => {
    const existing = await read(root);
    if (
      existing &&
      ActiveStates.includes(existing.state as (typeof ActiveStates)[number])
    )
      throw new SuriError(
        "MIGRATION_ALREADY_PENDING",
        "A migration approval already exists.",
      );
    const parsed = Approval.parse(approval);
    if (parsed.state !== "pending")
      throw new SuriError(
        "MIGRATION_APPROVAL_MISMATCH",
        "A new migration must start pending.",
      );
    await writeUpdateFile(fileFor(root), JSON.stringify(parsed));
    return parsed;
  });
}

export async function requestLegacyMigrationAdmission(
  root: string,
  operationId: string,
  helper: string,
) {
  return stateLocked(root, helper, async () => {
    const approval = await read(root);
    if (!approval || approval.operationId !== operationId)
      throw new SuriError(
        "MIGRATION_APPROVAL_MISMATCH",
        "Migration approval does not match this request.",
      );
    if (approval.state === "admission-requested") return approval;
    if (approval.state !== "pending")
      throw new SuriError(
        "MIGRATION_APPROVAL_MISMATCH",
        "Migration admission cannot be requested in this state.",
      );
    if (approval.expiresAt <= Date.now())
      throw new SuriError(
        "MIGRATION_APPROVAL_EXPIRED",
        "Migration approval expired.",
      );
    const requested = Approval.parse({
      ...approval,
      state: "admission-requested",
      admissionRequestedAt: Date.now(),
    });
    await writeUpdateFile(fileFor(root), JSON.stringify(requested));
    return requested;
  });
}

export async function claimLegacyMigration(
  root: string,
  supplied: LegacyMigrationApproval,
  helper: string,
) {
  return stateLocked(root, helper, async () => {
    const approval = await read(root);
    if (!approval || !sameTuple(approval, supplied))
      throw new SuriError(
        "MIGRATION_APPROVAL_MISMATCH",
        "Migration approval does not match this request.",
      );
    if (approval.state === "admitted") return approval;
    if (approval.state !== "admission-requested")
      throw new SuriError(
        "MIGRATION_APPROVAL_MISMATCH",
        "Migration admission was not durably requested.",
      );
    if (approval.expiresAt <= Date.now())
      throw new SuriError(
        "MIGRATION_APPROVAL_EXPIRED",
        "Migration approval expired.",
      );
    const admitted = Approval.parse({
      ...approval,
      state: "admitted",
      admittedAt: Date.now(),
    });
    await writeUpdateFile(fileFor(root), JSON.stringify(admitted));
    return admitted;
  });
}

async function transition(
  root: string,
  operationId: string,
  expected: LegacyMigrationApproval["state"][],
  next: Partial<LegacyMigrationApproval>,
  helper: string,
) {
  return stateLocked(root, helper, async () => {
    const approval = await read(root);
    if (
      !approval ||
      approval.operationId !== operationId ||
      !expected.includes(approval.state)
    )
      throw new SuriError(
        "MIGRATION_APPROVAL_MISMATCH",
        "Migration transition does not match persisted authority.",
      );
    const updated = Approval.parse({ ...approval, ...next });
    await writeUpdateFile(fileFor(root), JSON.stringify(updated));
    return updated;
  });
}

export function markLegacyMigrationSourceStopped(
  root: string,
  operationId: string,
  helper: string,
) {
  return transition(
    root,
    operationId,
    ["admitted", "source-stopped"],
    {
      state: "source-stopped",
      sourceStoppedAt: Date.now(),
    },
    helper,
  );
}

export function markLegacyMigrationReplacementVerified(
  root: string,
  operationId: string,
  replacement: { pid: number; instanceId: string },
  helper: string,
) {
  return transition(
    root,
    operationId,
    ["source-stopped", "replacement-verified"],
    {
      state: "replacement-verified",
      replacementVerifiedAt: Date.now(),
      replacementPid: replacement.pid,
      replacementInstanceId: replacement.instanceId,
    },
    helper,
  );
}

export async function finishLegacyMigration(
  root: string,
  operationId: string,
  state: "succeeded" | "failed",
  helper: string,
  replacement?: { pid: number; instanceId: string },
  failureCode = "MIGRATION_FAILED",
) {
  if (state === "failed")
    return transition(
      root,
      operationId,
      ["pending", "admission-requested"],
      { state, finishedAt: Date.now(), failureCode },
      helper,
    );
  return stateLocked(root, helper, async () => {
    const approval = await read(root);
    if (
      !approval ||
      approval.operationId !== operationId ||
      approval.state !== "replacement-verified" ||
      !replacement ||
      approval.replacementPid !== replacement.pid ||
      approval.replacementInstanceId !== replacement.instanceId
    )
      throw new SuriError(
        "MIGRATION_APPROVAL_MISMATCH",
        "Migration success does not match the verified replacement.",
      );
    const succeeded = Approval.parse({
      ...approval,
      state: "succeeded",
      finishedAt: Date.now(),
    });
    await writeUpdateFile(fileFor(root), JSON.stringify(succeeded));
    return succeeded;
  });
}
