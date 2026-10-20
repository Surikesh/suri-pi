import type {
  ChainAdapter,
  ChainPlan,
  Stage,
  StageReceipt,
} from "./chain-types.js";
import { boundedPrompt, exec, json, type Exec } from "./adapter-shared.js";

export class HerdrAdapter implements ChainAdapter {
  readonly kind = "herdr" as const;
  constructor(
    private readonly run: Exec = exec,
    private readonly context = process.env,
  ) {}
  async preflight(_plan: ChainPlan, stage: Stage) {
    if (this.context.HERDR_ENV !== "1" || !this.context.HERDR_PANE_ID)
      throw new Error("HERDR_UNAVAILABLE");
    if (stage.provider !== "openai-codex")
      throw new Error("PROVIDER_NOT_AUTHORIZED");
    const catalog = await this.run("pi", ["--list-models"]);
    if (
      catalog.code !== 0 ||
      !catalog.stdout
        .split("\n")
        .some(
          (line) =>
            line.includes("openai-codex") && line.includes(stage.modelId),
        )
    )
      throw new Error("MODEL_UNAVAILABLE");
  }
  async dispatch(
    plan: ChainPlan,
    stage: Stage,
    attemptId: string,
  ): Promise<StageReceipt> {
    const split = await this.run("herdr", [
      "pane",
      "split",
      "--pane",
      String(this.context.HERDR_PANE_ID),
      "--direction",
      "right",
      "--cwd",
      plan.workspace,
      "--no-focus",
    ]);
    if (split.code !== 0) throw new Error("HERDR_PANE_CREATE_INDETERMINATE");
    const created = json(split.stdout);
    const paneId = created.result?.pane?.pane_id;
    if (!paneId) throw new Error("HERDR_PANE_RECEIPT_MISSING");
    const name = `chain-${attemptId.slice(0, 8)}`;
    const started = await this.run("herdr", [
      "agent",
      "start",
      name,
      "--kind",
      "pi",
      "--pane",
      paneId,
      "--",
      "--provider",
      stage.provider,
      "--model",
      stage.modelId,
      "--thinking",
      stage.thinking,
    ]);
    if (started.code !== 0) throw new Error("HERDR_AGENT_START_INDETERMINATE");
    const agent = json(started.stdout);
    const workspaceId =
      agent.result?.agent?.workspace_id ?? paneId.split(":p")[0];
    const tabId = agent.result?.agent?.tab_id;
    const prompted = await this.run("herdr", [
      "agent",
      "prompt",
      name,
      boundedPrompt(plan, stage, attemptId),
    ]);
    if (prompted.code !== 0) throw new Error("HERDR_PROMPT_INDETERMINATE");
    return {
      attemptId,
      sessionId: agent.result?.agent?.session_id ?? name,
      adapter: "herdr",
      workspaceId,
      tabId,
      paneId,
      provider: stage.provider,
      modelId: stage.modelId,
      thinking: stage.thinking,
    };
  }
  async reconcile(_plan: ChainPlan, _stage: Stage, attemptId: string) {
    const found = await this.run("herdr", [
      "agent",
      "get",
      `chain-${attemptId.slice(0, 8)}`,
    ]);
    if (found.code !== 0) return null;
    const data = json(found.stdout).result?.agent;
    if (!data?.pane_id) return null;
    return {
      attemptId,
      sessionId: data.session_id ?? data.name,
      adapter: "herdr" as const,
      workspaceId: data.workspace_id,
      tabId: data.tab_id,
      paneId: data.pane_id,
      provider: "openai-codex" as const,
      modelId: String(data.model_id ?? ""),
      thinking: data.thinking,
    };
  }
  async observe() {
    return null;
  }
}
