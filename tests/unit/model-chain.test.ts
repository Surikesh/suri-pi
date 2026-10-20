import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import {
  DurableChain,
  type ChainAdapter,
  type ChainPlan,
  type StageReceipt,
} from "../../packages/model-chain/src/index.js";
import {
  HerdrAdapter,
  SuriAdapter,
} from "../../packages/model-chain/src/adapters.js";
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
async function harness(adapter: "herdr" | "suri" = "suri") {
  const root = await mkdtemp(join(tmpdir(), "suri-chain-"));
  roots.push(root);
  const workspace = await mkdtemp(join(tmpdir(), "suri-workspace-"));
  roots.push(workspace);
  const plan: ChainPlan = {
    schemaVersion: 1,
    requestId: randomUUID(),
    taskId: "tm-task",
    goal: "Implement and verify",
    workspace,
    adapter,
    stages: [
      {
        id: "implement",
        dependencies: [],
        provider: "openai-codex",
        modelId: "gpt-5.6-luna",
        thinking: "xhigh",
        instruction: "Implement bounded scope",
        ownedPaths: ["src/a.ts"],
        acceptance: ["tests pass"],
      },
      {
        id: "review",
        dependencies: ["implement"],
        provider: "openai-codex",
        modelId: "gpt-6-astra",
        thinking: "low",
        instruction: "Review independently",
        ownedPaths: [],
        acceptance: ["approved"],
      },
    ],
  };
  return { chain: new DurableChain(root), plan };
}
function fake(kind: "herdr" | "suri") {
  const dispatches: string[] = [];
  const receipts = new Map<string, StageReceipt>();
  const failDispatch = false;
  const adapter: ChainAdapter & {
    dispatches: string[];
    failDispatch: boolean;
  } = {
    kind,
    dispatches,
    failDispatch,
    async preflight(_plan, stage) {
      if (stage.provider !== "openai-codex")
        throw new Error("PROVIDER_NOT_AUTHORIZED");
    },
    async dispatch(_plan, stage, attemptId) {
      dispatches.push(stage.id);
      if (adapter.failDispatch) throw null;
      const receipt = {
        attemptId,
        sessionId: `session-${stage.id}`,
        adapter: kind,
        provider: stage.provider,
        modelId: stage.modelId,
        thinking: stage.thinking,
      };
      receipts.set(attemptId, receipt);
      return receipt;
    },
    async reconcile(_plan, _stage, attemptId) {
      return receipts.get(attemptId) ?? null;
    },
    async observe() {
      return null;
    },
  };
  return adapter;
}
const result = (
  receipt: StageReceipt,
  verdict: "completed" | "failed" = "completed",
) => ({
  attemptId: receipt.attemptId,
  sessionId: receipt.sessionId,
  terminal: true as const,
  verdict,
  summary: receipt.sessionId.includes("review")
    ? "APPROVED bounded result"
    : "bounded result",
  checks: ["unit"],
  evidenceHash: createHash("sha256").update("evidence").digest("hex"),
});
describe("durable model chain", () => {
  it("launches and returns after one stage, then advances only on correlated evidence", async () => {
    const { chain, plan } = await harness();
    const adapter = fake("suri");
    await chain.create(plan);
    let state = await chain.step(plan.requestId, adapter);
    expect(state.status).toBe("running");
    expect(adapter.dispatches).toEqual(["implement"]);
    state = await chain.complete(
      plan.requestId,
      result(state.active!.receipt!),
    );
    expect(state.status).toBe("ready");
    state = await chain.step(plan.requestId, adapter);
    expect(adapter.dispatches).toEqual(["implement", "review"]);
    state = await chain.complete(
      plan.requestId,
      result(state.active!.receipt!),
    );
    expect(state.status).toBe("completed");
    expect(state.orchestrationModelCalls).toBe(0);
  });
  it("rejects a concurrent dispatcher before a duplicate launch", async () => {
    const { chain, plan } = await harness();
    const adapter = fake("suri");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original = adapter.preflight;
    adapter.preflight = async (...args) => {
      await gate;
      return original(...args);
    };
    await chain.create(plan);
    const first = chain.step(plan.requestId, adapter);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await expect(chain.step(plan.requestId, adapter)).rejects.toThrow(
      "CHAIN_BUSY_OR_RECOVERY_REQUIRED",
    );
    release();
    await first;
    expect(adapter.dispatches).toEqual(["implement"]);
  });

  it("deduplicates create and never retries an indeterminate dispatch", async () => {
    const { chain, plan } = await harness();
    const adapter = fake("suri");
    adapter.failDispatch = true;
    const first = await chain.create(plan);
    expect((await chain.create(plan)).revision).toBe(first.revision);
    const blocked = await chain.step(plan.requestId, adapter);
    expect(blocked.diagnostic?.code).toBe("DISPATCH_INDETERMINATE");
    await chain.step(plan.requestId, adapter);
    expect(adapter.dispatches).toEqual(["implement"]);
  });
  it("rejects stale evidence, unsafe paths, alternate providers, and adapter mismatch before another dispatch", async () => {
    const { chain, plan } = await harness();
    await expect(
      chain.create({
        ...plan,
        stages: [{ ...plan.stages[0], ownedPaths: ["../escape"] }],
      }),
    ).rejects.toThrow();
    await expect(
      chain.create({
        ...plan,
        requestId: randomUUID(),
        stages: [{ ...plan.stages[0], provider: "openrouter" }],
      }),
    ).rejects.toThrow();
    await chain.create(plan);
    await expect(chain.step(plan.requestId, fake("herdr"))).rejects.toThrow(
      "ADAPTER_MISMATCH",
    );
  });
  it("blocks failed checks and invalid or stale result packets", async () => {
    const { chain, plan } = await harness();
    const adapter = fake("suri");
    await chain.create(plan);
    let state = await chain.step(plan.requestId, adapter);
    await expect(
      chain.complete(plan.requestId, {
        ...result(state.active!.receipt!),
        attemptId: randomUUID(),
      }),
    ).rejects.toThrow("RESULT_REJECTED");
    state = await chain.complete(
      plan.requestId,
      result(state.active!.receipt!, "failed"),
    );
    expect(state.status).toBe("blocked");
    expect(adapter.dispatches).toHaveLength(1);
  });
});
describe("runtime adapters", () => {
  it("Herdr uses no-focus, exact provider/model/thinking and bounded prompt", async () => {
    const calls: string[][] = [];
    const run = async (_command: string, args: string[]) => {
      calls.push(args);
      if (args[0] === "--list-models")
        return { code: 0, stdout: "openai-codex gpt-5.6-luna", stderr: "" };
      if (args[0] === "pane")
        return {
          code: 0,
          stdout: JSON.stringify({ result: { pane: { pane_id: "w1:p2" } } }),
          stderr: "",
        };
      if (args[1] === "start")
        return {
          code: 0,
          stdout: JSON.stringify({
            result: {
              agent: {
                session_id: "pi-1",
                workspace_id: "w1",
                tab_id: "w1:t1",
              },
            },
          }),
          stderr: "",
        };
      return { code: 0, stdout: "{}", stderr: "" };
    };
    const { plan } = await harness("herdr");
    const adapter = new HerdrAdapter(run, {
      HERDR_ENV: "1",
      HERDR_PANE_ID: "w1:p1",
    });
    await adapter.preflight(plan, plan.stages[0]);
    const receipt = await adapter.dispatch(plan, plan.stages[0], "attempt");
    expect(receipt.sessionId).toBe("pi-1");
    expect(calls.some((args) => args.includes("--no-focus"))).toBe(true);
    expect(
      calls.some(
        (args) =>
          args.includes("openai-codex") &&
          args.includes("gpt-5.6-luna") &&
          args.includes("xhigh"),
      ),
    ).toBe(true);
  });
  it("Suri creates a visible session and verifies model/thinking before prompt over the private broker", async () => {
    const commands: any[] = [];
    const revision = 4;
    let targetSessionId = "";
    const transport = async (body: any) => {
      commands.push(body);
      if (body.type === "stage.register") {
        targetSessionId = body.payload.targetSessionId;
        return { ok: true, registrationId: "registration" };
      }
      const result =
        body.type === "host.get"
          ? { runtimeMode: "live" }
          : body.type === "session.create"
            ? { id: targetSessionId, revision }
            : body.type === "model.set"
              ? {
                  provider: "openai-codex",
                  id: "gpt-5.6-luna",
                  revision: revision + 7,
                }
              : body.type === "thinking.set"
                ? { level: "xhigh", revision: revision + 11 }
                : {};
      return {
        ok: true,
        chainContext: { runtimeId: "runtime" },
        receipt: {
          status: body.type === "run.submit" ? "accepted" : "completed",
          result,
        },
      };
    };
    const { plan } = await harness();
    const adapter = new SuriAdapter("", transport);
    await adapter.preflight(plan, plan.stages[0]);
    const receipt = await adapter.dispatch(plan, plan.stages[0], "attempt");
    expect(receipt.sessionId).toBe(targetSessionId);
    expect(commands.map((item) => item.type)).toEqual([
      "host.get",
      "stage.register",
      "session.create",
      "model.set",
      "thinking.set",
      "run.submit",
    ]);
    expect(commands[3].expectedRevision).toBe(4);
    expect(commands[4].expectedRevision).toBe(11);
    expect(JSON.stringify(commands)).not.toContain("openrouter");
    expect(JSON.stringify(commands)).not.toContain("cookie");
    expect(commands[5].payload.text).toContain(`sessionId=${targetSessionId}`);
    expect(commands[1].payload.promptHash).toMatch(/^[a-f0-9]{64}$/);
  });
  it("completes a synthetic two-stage Suri chain with one fresh registration and visible session per stage", async () => {
    const { chain, plan } = await harness();
    const sessions: string[] = [];
    const submissions: string[] = [];
    const targets = new Map<string, string>();
    const transport = async (body: any) => {
      if (body.type === "host.get")
        return {
          ok: true,
          chainContext: { runtimeId: "runtime" },
          receipt: {
            status: "completed",
            result: { runtimeMode: "simulated" },
          },
        };
      if (body.type === "stage.register") {
        targets.set(body.stageId, body.payload.targetSessionId);
        return { ok: true, registrationId: `registration-${body.stageId}` };
      }
      const sessionId = targets.get(body.stageId)!;
      let result: any = {};
      if (body.type === "session.create") {
        sessions.push(sessionId);
        result = { id: sessionId, revision: 3 };
      } else if (body.type === "model.set")
        result = {
          provider: body.payload.provider,
          id: body.payload.id,
          revision: 9,
        };
      else if (body.type === "thinking.set")
        result = { level: body.payload.level, revision: 14 };
      else if (body.type === "run.submit") submissions.push(sessionId);
      return {
        ok: true,
        receipt: {
          status: body.type === "run.submit" ? "accepted" : "completed",
          result,
        },
      };
    };
    const adapter = new SuriAdapter("", transport);
    await chain.create(plan);
    let state = await chain.step(plan.requestId, adapter);
    const first = state.active!.receipt!;
    expect(state.status).toBe("running");
    state = await chain.complete(plan.requestId, result(first));
    expect(state.status).toBe("ready");
    await expect(chain.complete(plan.requestId, result(first))).rejects.toThrow(
      "NO_RUNNING_STAGE",
    );
    state = await chain.step(plan.requestId, adapter);
    const second = state.active!.receipt!;
    expect(second.sessionId).not.toBe(first.sessionId);
    state = await chain.complete(plan.requestId, {
      ...result(second),
      summary: "APPROVED synthetic review",
    });
    expect(state.status).toBe("completed");
    expect(sessions).toEqual([first.sessionId, second.sessionId]);
    expect(submissions).toEqual(sessions);
  });

  it("durably blocks a pre-step startup failure and refuses another startup", async () => {
    const { chain, plan } = await harness();
    await chain.create(plan);
    const blocked = await chain.blockStartup(
      plan.requestId,
      "SURI_CHAIN_CAPABILITY_UNAVAILABLE",
    );
    expect(blocked.status).toBe("blocked");
    expect(blocked.diagnostic?.code).toBe("SURI_CHAIN_CAPABILITY_UNAVAILABLE");
    await expect(
      chain.blockStartup(plan.requestId, "RUNNER_START_FAILED"),
    ).rejects.toThrow("STARTUP_FEEDBACK_REJECTED");
  });
});
