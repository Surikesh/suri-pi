import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, open } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { BuildIdSchema } from "../../../packages/protocol/src/updates.js";
import { writeUpdateFile } from "./update-state.js";

const Binding = z.strictObject({
  operationId: z.uuid(),
  fromInstanceId: z.uuid(),
  profileId: z.uuid(),
  targetBuildId: BuildIdSchema,
  origin: z.string().url(),
});
export type RestartBinding = z.infer<typeof Binding>;
const HandoffRecord = Binding.extend({
  authClientId: z.string().min(1).max(128),
  verifier: BuildIdSchema,
  expiresAt: z.number().int(),
  toInstanceId: z.uuid().nullable(),
});
const CommitRecord = z.strictObject({
  operationId: z.uuid(),
  targetBuildId: BuildIdSchema,
  toInstanceId: z.uuid(),
  committedAt: z.number().int(),
});
const State = z.strictObject({
  schema: z.literal(2),
  handoffs: z.array(HandoffRecord).max(256),
  commits: z.array(CommitRecord).max(256),
});
type RestartHandoffState = z.infer<typeof State>;
class HandoffFailure extends Error {
  constructor(
    readonly code:
      | "HANDOFF_INVALID"
      | "HANDOFF_EXPIRED"
      | "HANDOFF_IDENTITY_CHANGED"
      | "HANDOFF_UNAVAILABLE",
  ) {
    super(code);
  }
}
const hash = (secret: string) =>
  createHash("sha256").update(secret).digest("hex");
const equal = (a: string, b: string) =>
  timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
const emptyState = (): RestartHandoffState => ({
  schema: 2,
  handoffs: [],
  commits: [],
});

// Browser verifiers are consumable capabilities. Restart commits are durable
// lifecycle evidence. They share one atomic file update, but consumption and
// revocation can never erase the operation/build/instance commit fact.
export class RestartHandoffs {
  private queue: Promise<unknown> = Promise.resolve();
  private readonly path: string;
  constructor(
    private readonly root: string,
    private readonly now = Date.now,
  ) {
    this.path = join(root, "run/restart-handoffs.json");
  }
  private async state(): Promise<RestartHandoffState> {
    try {
      const fd = await open(
        this.path,
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      try {
        const stat = await fd.stat();
        if (!stat.isFile() || stat.size > 128 * 1024) throw Error();
        const parsed = JSON.parse(await fd.readFile("utf8"));
        // Read the pre-ledger representation so an already staged restart can
        // be upgraded without making its unbound bearer consumable.
        if (Array.isArray(parsed))
          return State.parse({ schema: 2, handoffs: parsed, commits: [] });
        return State.parse(parsed);
      } finally {
        await fd.close();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return emptyState();
      throw new HandoffFailure("HANDOFF_UNAVAILABLE");
    }
  }
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn);
    // The queue only orders operations; each caller receives its own failure via next, so the chain continues after one.
    this.queue = next.catch(() => {});
    return next;
  }
  private async write(state: RestartHandoffState) {
    await mkdir(join(this.root, "run"), { recursive: true, mode: 0o700 });
    await writeUpdateFile(this.path, JSON.stringify(State.parse(state)));
  }
  async mint(binding: RestartBinding, authClientId: string) {
    return this.serial(async () => {
      const secret = randomBytes(32).toString("hex");
      const record = HandoffRecord.parse({
        ...binding,
        authClientId,
        verifier: hash(secret),
        expiresAt: this.now() + 120_000,
        toInstanceId: null,
      });
      const state = await this.state();
      const handoffs = state.handoffs.filter((r) => r.expiresAt > this.now());
      if (handoffs.length >= 256)
        throw new HandoffFailure("HANDOFF_UNAVAILABLE");
      await this.write({ ...state, handoffs: [...handoffs, record] });
      return secret;
    });
  }
  async bind(operationId: string, targetBuildId: string, toInstanceId: string) {
    return this.commit(
      operationId,
      targetBuildId,
      toInstanceId,
      async () => {},
    );
  }
  async commit(
    operationId: string,
    targetBuildId: string,
    toInstanceId: string,
    terminal: () => Promise<void>,
  ) {
    return this.serial(async () => {
      const state = await this.state();
      const existing = state.commits.find((r) => r.operationId === operationId);
      if (existing) {
        if (
          existing.targetBuildId !== targetBuildId ||
          existing.toInstanceId !== toInstanceId
        )
          throw new HandoffFailure("HANDOFF_IDENTITY_CHANGED");
        return;
      }
      const matching = state.handoffs.filter(
        (record) =>
          record.operationId === operationId &&
          record.targetBuildId === targetBuildId &&
          record.expiresAt > this.now(),
      );
      if (
        matching.some(
          (record) =>
            record.toInstanceId && record.toInstanceId !== toInstanceId,
        )
      )
        throw new HandoffFailure("HANDOFF_IDENTITY_CHANGED");
      const conflicting = state.handoffs.some(
        (record) =>
          record.operationId === operationId &&
          record.targetBuildId !== targetBuildId,
      );
      if (conflicting) throw new HandoffFailure("HANDOFF_IDENTITY_CHANGED");
      const bound = state.handoffs.map((record) =>
        record.operationId === operationId &&
        record.targetBuildId === targetBuildId
          ? { ...record, toInstanceId }
          : record,
      );
      // VERIFIED evidence is durable first. The following single atomic write
      // publishes both the independent commit fact and any optional bearers.
      await terminal();
      const commits = [
        ...state.commits.filter((record) => record.operationId !== operationId),
        CommitRecord.parse({
          operationId,
          targetBuildId,
          toInstanceId,
          committedAt: this.now(),
        }),
      ].slice(-256);
      await this.write({ schema: 2, handoffs: bound, commits });
    });
  }
  async isBound(
    operationId: string,
    targetBuildId: string,
    toInstanceId: string,
  ) {
    return this.serial(async () =>
      (await this.state()).commits.some(
        (record) =>
          record.operationId === operationId &&
          record.targetBuildId === targetBuildId &&
          record.toInstanceId === toInstanceId,
      ),
    );
  }
  async revoke(operationId: string) {
    return this.serial(async () => {
      const state = await this.state();
      // A durable commit is terminal success. Revocation is only a pre-commit
      // rollback and must not invalidate already admitted browser commands.
      if (state.commits.some((r) => r.operationId === operationId))
        return false;
      if (state.handoffs.some((r) => r.operationId === operationId))
        await this.write({
          ...state,
          handoffs: state.handoffs.filter((r) => r.operationId !== operationId),
        });
      return true;
    });
  }
  async consume(
    secret: string | undefined,
    expected: {
      profileId: string;
      targetBuildId: string | null;
      instanceId: string;
      origin: string;
    },
  ) {
    return this.serial(async () => {
      if (!secret || !/^[a-f0-9]{64}$/.test(secret))
        throw new HandoffFailure("HANDOFF_INVALID");
      const state = await this.state();
      const verifier = hash(secret);
      const record = state.handoffs.find((r) => equal(r.verifier, verifier));
      if (!record) throw new HandoffFailure("HANDOFF_INVALID");
      if (record.expiresAt <= this.now())
        throw new HandoffFailure("HANDOFF_EXPIRED");
      if (
        record.profileId !== expected.profileId ||
        record.targetBuildId !== expected.targetBuildId ||
        record.origin !== expected.origin ||
        record.fromInstanceId === expected.instanceId ||
        record.toInstanceId !== expected.instanceId
      )
        throw new HandoffFailure("HANDOFF_IDENTITY_CHANGED");
      await this.write({
        ...state,
        handoffs: state.handoffs.filter(
          (r) =>
            r.operationId !== record.operationId ||
            r.authClientId !== record.authClientId,
        ),
      });
      return {
        authClientId: record.authClientId,
        operationId: record.operationId,
      };
    });
  }
}
