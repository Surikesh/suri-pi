import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import {
  DurableChain,
  chainPlanSchema,
  type ChainPlan,
} from "../../packages/model-chain/src/index.js";
import {
  consumeFdBrokerHandshake,
  HerdrAdapter,
  SuriAdapter,
} from "../../packages/model-chain/src/adapters.js";

const root =
  process.env.SURI_CHAIN_STATE_DIR ??
  join(process.cwd(), ".tm-runtime", "pi-chain");
const chain = new DurableChain(root);
const thinking = StringEnum([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const);
const stage = Type.Object({
  id: Type.String({ pattern: "^[a-z][a-z0-9-]{0,63}$" }),
  dependencies: Type.Array(Type.String(), { maxItems: 32 }),
  provider: Type.Literal("openai-codex"),
  modelId: Type.String({ minLength: 1, maxLength: 160 }),
  thinking,
  instruction: Type.String({ minLength: 1, maxLength: 20000 }),
  ownedPaths: Type.Array(Type.String({ minLength: 1, maxLength: 500 }), {
    maxItems: 100,
  }),
  acceptance: Type.Array(Type.String({ minLength: 1, maxLength: 500 }), {
    minItems: 1,
    maxItems: 20,
  }),
});
const planParameters = Type.Object({
  schemaVersion: Type.Literal(1),
  requestId: Type.String({ format: "uuid" }),
  taskId: Type.String({ minLength: 1, maxLength: 100 }),
  goal: Type.String({ minLength: 1, maxLength: 4000 }),
  workspace: Type.String({ minLength: 1, maxLength: 4096 }),
  adapter: StringEnum(["herdr", "suri"] as const),
  stages: Type.Array(stage, { minItems: 1, maxItems: 12 }),
});
const text = (value: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value) }],
});
const validationMessage = (error: unknown) => {
  const issues = (
    error as { issues?: Array<{ path?: PropertyKey[]; message?: string }> }
  )?.issues;
  if (!issues?.length)
    return error instanceof Error ? error.message : "PLAN_INVALID";
  return issues
    .slice(0, 5)
    .map(
      (issue) =>
        `${issue.path?.join(".") || "plan"}: ${issue.message || "invalid"}`,
    )
    .join("; ");
};
async function adapter(plan: ChainPlan) {
  if (plan.adapter === "herdr") return new HerdrAdapter();
  try {
    return new SuriAdapter();
  } catch {
    await chain.blockStartup(
      plan.requestId,
      "SURI_CHAIN_CAPABILITY_UNAVAILABLE",
    );
    return null;
  }
}
async function dispatch(plan: ChainPlan) {
  const selected = await adapter(plan);
  if (!selected) return chain.read(plan.requestId);
  try {
    return await chain.step(plan.requestId, selected);
  } catch (error) {
    const code = error instanceof Error ? error.message : "RUNNER_START_FAILED";
    if (code === "SURI_CHAIN_CAPABILITY_UNAVAILABLE")
      return chain.blockStartup(plan.requestId, code);
    throw error;
  }
}

export default async function modelChain(pi: ExtensionAPI) {
  // Extension factories are awaited before tools become callable. Consume the
  // startup-delivered capability into memory here; absence stays fail-closed.
  await consumeFdBrokerHandshake().catch(() => undefined);
  pi.registerTool({
    name: "model_chain",
    label: "Model Chain",
    description:
      "Launch, inspect, cancel, or resume a durable fixed Pi model chain. Launch returns only running with a correlated receipt or blocked with a bounded diagnostic. Provide plan as a schema-v1 object, not JSON text.",
    parameters: Type.Object({
      action: StringEnum(["launch", "status", "cancel", "resume"] as const),
      requestId: Type.Optional(Type.String({ format: "uuid" })),
      plan: Type.Optional(planParameters),
    }),
    async execute(_id, params) {
      if (params.action === "launch") {
        if (!params.plan) throw new Error("plan: required for launch");
        let plan: ChainPlan;
        try {
          plan = chainPlanSchema.parse(params.plan);
        } catch (error) {
          throw new Error(`PLAN_INVALID: ${validationMessage(error)}`);
        }
        await chain.create(plan);
        const state = await dispatch(plan);
        return text({
          requestId: plan.requestId,
          taskId: plan.taskId,
          status: state.status,
          receipt: state.active?.receipt ?? null,
          diagnostic: state.diagnostic,
          adapter: plan.adapter,
        });
      }
      if (!params.requestId) throw new Error("requestId: required");
      if (params.action === "status")
        return text(await chain.read(params.requestId));
      if (params.action === "resume") {
        const state = await chain.read(params.requestId);
        if (state.status !== "ready" || state.diagnostic || state.active)
          throw new Error("RESUME_NOT_ADMITTED");
        return text(await dispatch(state.plan));
      }
      await chain.stopFuture(params.requestId);
      return text({ requestId: params.requestId, status: "cancelled" });
    },
  });
  pi.registerTool({
    name: "model_chain_result",
    label: "Model Chain Result",
    description:
      "Submit the deterministic terminal result for the exact active chain attempt and advance at most once.",
    parameters: Type.Object({
      requestId: Type.String({ format: "uuid" }),
      attemptId: Type.String({ format: "uuid" }),
      sessionId: Type.String({ format: "uuid" }),
      verdict: StringEnum(["completed", "failed", "blocked"] as const),
      summary: Type.String({ minLength: 1, maxLength: 2000 }),
      checks: Type.Array(Type.String({ minLength: 1, maxLength: 500 }), {
        minItems: 1,
        maxItems: 20,
      }),
      evidence: Type.String({ minLength: 1, maxLength: 20000 }),
    }),
    async execute(_id, params) {
      const state = await chain.complete(params.requestId, {
        attemptId: params.attemptId,
        sessionId: params.sessionId,
        terminal: true,
        verdict: params.verdict,
        summary: params.summary,
        checks: params.checks,
        evidenceHash: createHash("sha256")
          .update(params.evidence)
          .digest("hex"),
      });
      const next =
        state.status === "ready" ? await dispatch(state.plan) : state;
      return text({
        requestId: params.requestId,
        status: next.status,
        nextStage: next.plan.stages[next.index]?.id ?? null,
        receipt: next.active?.receipt ?? null,
        diagnostic: next.diagnostic,
      });
    },
  });
  pi.registerCommand("model-chain", {
    description: "Launch a schema-v1 JSON plan or show status by request id",
    handler: async (args, ctx) => {
      const value = args.trim();
      if (!value)
        return ctx.ui.notify(
          "Usage: /model-chain <plan-json|request-id>",
          "warning",
        );
      try {
        if (value.startsWith("{")) {
          const plan = chainPlanSchema.parse(JSON.parse(value));
          await chain.create(plan);
          const state = await dispatch(plan);
          ctx.ui.notify(
            `Chain ${plan.requestId}: ${state.status}`,
            state.status === "running" ? "info" : "warning",
          );
        } else {
          const state = await chain.read(value);
          ctx.ui.notify(
            `Chain ${value}: ${state.status}, stage ${state.index + 1}/${state.plan.stages.length}`,
            "info",
          );
        }
      } catch (error) {
        ctx.ui.notify(
          `Chain rejected: ${validationMessage(error)}`.slice(0, 500),
          "error",
        );
      }
    },
  });
}
