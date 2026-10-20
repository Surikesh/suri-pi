import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  rename,
  rmdir,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { chainPlanSchema } from "./plan-schema.js";
import type {
  ChainAdapter,
  ChainState,
  Stage,
  StageReceipt,
  StageResult,
} from "./chain-types.js";

export { chainPlanSchema };
export type {
  ChainAdapter,
  ChainPlan,
  ChainState,
  Stage,
  StageReceipt,
  StageResult,
} from "./chain-types.js";

const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const safeError = (value: unknown) =>
  value instanceof Error ? value.message : "ADAPTER_FEEDBACK_UNAVAILABLE";
async function atomic(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2), {
    mode: 0o600,
    flag: "wx",
  });
  await rename(temporary, path);
}
export class DurableChain {
  constructor(private readonly root: string) {}
  private path(requestId: string) {
    return join(this.root, `${requestId}.json`);
  }
  private async lock<T>(requestId: string, action: () => Promise<T>) {
    const path = join(this.root, `${requestId}.lock`);
    try {
      await mkdir(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "EEXIST")
        throw new Error("CHAIN_BUSY_OR_RECOVERY_REQUIRED");
      throw error;
    }
    try {
      return await action();
    } finally {
      await rmdir(path);
    }
  }
  async read(requestId: string): Promise<ChainState> {
    return JSON.parse(await readFile(this.path(requestId), "utf8"));
  }
  private async save(state: ChainState) {
    state.revision += 1;
    await atomic(this.path(state.plan.requestId), state);
    return structuredClone(state);
  }
  async create(input: unknown) {
    const plan = chainPlanSchema.parse(input);
    const canonical = resolve(plan.workspace);
    if (canonical !== plan.workspace)
      throw new Error("WORKSPACE_NOT_CANONICAL");
    const path = this.path(plan.requestId);
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    let handle;
    try {
      handle = await open(path, "wx", 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "EEXIST") {
        const existing = await this.read(plan.requestId);
        if (existing.planHash !== hash(plan))
          throw new Error("REQUEST_ID_CONFLICT");
        return existing;
      }
      throw error;
    }
    const state: ChainState = {
      schemaVersion: 1,
      plan,
      planHash: hash(plan),
      status: "ready",
      index: 0,
      active: null,
      results: [],
      diagnostic: null,
      orchestrationModelCalls: 0,
      revision: 1,
    };
    await handle.writeFile(JSON.stringify(state, null, 2));
    await handle.sync();
    await handle.close();
    return state;
  }
  async blockStartup(requestId: string, code: string) {
    return this.lock(requestId, async () => {
      const state = await this.read(requestId);
      if (state.status !== "ready" || state.active)
        throw new Error("STARTUP_FEEDBACK_REJECTED");
      const allowed = new Set([
        "SURI_CHAIN_CAPABILITY_UNAVAILABLE",
        "SURI_CHAIN_CAPABILITY_INVALID",
        "RUNNER_START_FAILED",
        "RUNNER_FEEDBACK_TIMEOUT",
        "HERDR_UNAVAILABLE",
      ]);
      state.status = "blocked";
      state.diagnostic = {
        code: allowed.has(code) ? code : "RUNNER_START_FAILED",
        retryable: false,
      };
      return this.save(state);
    });
  }
  async step(requestId: string, adapter: ChainAdapter) {
    return this.lock(requestId, async () => {
      const state = await this.read(requestId);
      if (state.status !== "ready") return state;
      if (adapter.kind !== state.plan.adapter)
        throw new Error("ADAPTER_MISMATCH");
      const stage = state.plan.stages[state.index];
      if (!stage) return state;
      try {
        await adapter.preflight(state.plan, stage);
      } catch (error) {
        state.status = "blocked";
        state.diagnostic = { code: safeError(error), retryable: false };
        return this.save(state);
      }
      const attemptId = randomUUID();
      state.status = "dispatching";
      state.active = { stageId: stage.id, attemptId, receipt: null };
      state.diagnostic = {
        code: "DISPATCH_INTENT_PERSISTED",
        retryable: false,
      };
      await this.save(state);
      try {
        state.active.receipt = await adapter.dispatch(
          state.plan,
          stage,
          attemptId,
        );
        this.assertReceipt(state, stage, state.active.receipt);
        state.status = "running";
        state.diagnostic = null;
        await this.save(state);
      } catch {
        state.status = "blocked";
        state.diagnostic = { code: "DISPATCH_INDETERMINATE", retryable: false };
        return this.save(state);
      }
      return this.observe(state, adapter);
    });
  }
  private assertReceipt(
    state: ChainState,
    stage: Stage,
    receipt: StageReceipt,
  ) {
    if (
      receipt.attemptId !== state.active?.attemptId ||
      receipt.adapter !== state.plan.adapter ||
      receipt.provider !== stage.provider ||
      receipt.modelId !== stage.modelId ||
      receipt.thinking !== stage.thinking ||
      !receipt.sessionId
    )
      throw new Error("RECEIPT_MISMATCH");
  }
  private async observe(state: ChainState, adapter: ChainAdapter) {
    const stage = state.plan.stages[state.index];
    const receipt = state.active?.receipt;
    if (!receipt) return state;
    let result;
    try {
      result = await adapter.observe(state.plan, stage, receipt);
    } catch {
      state.status = "blocked";
      state.diagnostic = { code: "OBSERVATION_UNAVAILABLE", retryable: false };
      return this.save(state);
    }
    if (!result) return state;
    if (
      result.attemptId !== receipt.attemptId ||
      result.sessionId !== receipt.sessionId ||
      result.terminal !== true ||
      !/^[a-f0-9]{64}$/.test(result.evidenceHash) ||
      !result.checks.length
    ) {
      state.status = "blocked";
      state.diagnostic = { code: "RESULT_REJECTED", retryable: false };
      return this.save(state);
    }
    state.results.push(result);
    state.active = null;
    if (result.verdict !== "completed") {
      state.status = "blocked";
      state.diagnostic = {
        code: `STAGE_${result.verdict.toUpperCase()}`,
        retryable: false,
      };
      return this.save(state);
    }
    state.index += 1;
    state.status =
      state.index === state.plan.stages.length ? "completed" : "ready";
    state.diagnostic = null;
    return this.save(state);
  }
  async complete(requestId: string, result: StageResult) {
    return this.lock(requestId, async () => {
      const state = await this.read(requestId);
      const receipt = state.active?.receipt;
      if (!receipt || state.status !== "running")
        throw new Error("NO_RUNNING_STAGE");
      if (
        result.attemptId !== receipt.attemptId ||
        result.sessionId !== receipt.sessionId ||
        result.terminal !== true ||
        !/^[a-f0-9]{64}$/.test(result.evidenceHash) ||
        !result.checks.length ||
        result.checks.length > 20 ||
        result.summary.length < 1 ||
        result.summary.length > 2000
      )
        throw new Error("RESULT_REJECTED");
      const stage = state.plan.stages[state.index];
      if (
        stage?.id.toLowerCase().includes("review") &&
        !/^(APPROVED|REJECTED)\b/.test(result.summary)
      )
        throw new Error("RESULT_REJECTED");
      if (
        stage?.id.toLowerCase().includes("review") &&
        result.summary.startsWith("REJECTED") &&
        result.verdict === "completed"
      )
        throw new Error("RESULT_REJECTED");
      state.results.push(structuredClone(result));
      state.active = null;
      if (result.verdict !== "completed") {
        state.status = "blocked";
        state.diagnostic = {
          code: `STAGE_${result.verdict.toUpperCase()}`,
          retryable: false,
        };
        return this.save(state);
      }
      state.index += 1;
      state.status =
        state.index === state.plan.stages.length ? "completed" : "ready";
      state.diagnostic = null;
      return this.save(state);
    });
  }
  async reconcile(requestId: string, adapter: ChainAdapter) {
    return this.lock(requestId, async () => {
      const state = await this.read(requestId);
      const stage = state.plan.stages[state.index];
      if (!state.active) return state;
      if (!state.active.receipt) {
        const receipt = await adapter.reconcile(
          state.plan,
          stage,
          state.active.attemptId,
        );
        if (!receipt) return state;
        this.assertReceipt(state, stage, receipt);
        state.active.receipt = receipt;
        state.status = "running";
        state.diagnostic = null;
        await this.save(state);
      }
      return this.observe(state, adapter);
    });
  }
  async stopFuture(requestId: string) {
    return this.lock(requestId, async () => {
      const state = await this.read(requestId);
      state.status = "cancelled";
      state.diagnostic = null;
      return this.save(state);
    });
  }
  async cancel(requestId: string, adapter: ChainAdapter) {
    return this.lock(requestId, async () => {
      const state = await this.read(requestId);
      if (state.active?.receipt && adapter.cancel)
        await adapter.cancel(state.active.receipt);
      state.status = "cancelled";
      state.diagnostic = null;
      return this.save(state);
    });
  }
}
