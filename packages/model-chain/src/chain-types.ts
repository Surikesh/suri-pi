import type { z } from "zod";
import type { chainPlanSchema } from "./plan-schema.js";

export type ChainPlan = z.infer<typeof chainPlanSchema>;
export type Stage = ChainPlan["stages"][number];
export type StageReceipt = {
  attemptId: string;
  sessionId: string;
  adapter: "herdr" | "suri";
  workspaceId?: string;
  tabId?: string;
  paneId?: string;
  provider: "openai-codex";
  modelId: string;
  thinking: Stage["thinking"];
};
export type StageResult = {
  attemptId: string;
  sessionId: string;
  terminal: true;
  verdict: "completed" | "failed" | "blocked";
  summary: string;
  checks: string[];
  evidenceHash: string;
};
export interface ChainAdapter {
  readonly kind: "herdr" | "suri";
  preflight(plan: ChainPlan, stage: Stage): Promise<void>;
  dispatch(
    plan: ChainPlan,
    stage: Stage,
    attemptId: string,
  ): Promise<StageReceipt>;
  reconcile(
    plan: ChainPlan,
    stage: Stage,
    attemptId: string,
  ): Promise<StageReceipt | null>;
  observe(
    plan: ChainPlan,
    stage: Stage,
    receipt: StageReceipt,
  ): Promise<StageResult | null>;
  cancel?(receipt: StageReceipt): Promise<void>;
}
export type ChainState = {
  schemaVersion: 1;
  plan: ChainPlan;
  planHash: string;
  status:
    "ready" | "dispatching" | "running" | "blocked" | "completed" | "cancelled";
  index: number;
  active: null | {
    stageId: string;
    attemptId: string;
    receipt: StageReceipt | null;
  };
  results: StageResult[];
  diagnostic: null | { code: string; retryable: false };
  orchestrationModelCalls: 0;
  revision: number;
};
