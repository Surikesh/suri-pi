import { createHash, randomUUID } from "node:crypto";
import type {
  ChainAdapter,
  ChainPlan,
  Stage,
  StageReceipt,
  StageResult,
} from "./chain-types.js";
import { boundedPrompt } from "./adapter-shared.js";
import {
  takeStartupBrokerTransport,
  type SuriChainTransport,
} from "./fd-broker.js";

type CommandResult = {
  runtimeMode?: unknown;
  id?: unknown;
  provider?: unknown;
  level?: unknown;
  revision?: number;
  receiptStatus?: string;
  [field: string]: unknown;
};
type TransportReply = {
  ok?: unknown;
  code?: string;
  chainContext?: { runtimeId?: unknown };
  registrationId: string;
  receipt?: {
    status?: string;
    error?: { code?: string };
    result?: CommandResult;
  };
};

const digest = (text: string) =>
  createHash("sha256").update(text).digest("hex");

export class SuriAdapter implements ChainAdapter {
  readonly kind = "suri" as const;
  constructor(
    private runtimeId = "",
    private readonly transport: SuriChainTransport = takeStartupBrokerTransport(),
  ) {}
  private plan!: ChainPlan;
  private stageId = "";
  private registrationId = "";
  private async command(
    type: string,
    payload: Record<string, unknown>,
    sessionId?: string,
    expectedRevision?: number,
  ): Promise<CommandResult> {
    const response = (await this.transport({
      protocol: "suri-model-chain-v1",
      requestId: this.plan.requestId,
      stageId: this.stageId,
      workspace: this.plan.workspace,
      runtimeId: this.runtimeId,
      commandId: randomUUID(),
      type,
      ...(this.registrationId ? { registrationId: this.registrationId } : {}),
      ...(sessionId ? { sessionId } : {}),
      ...(expectedRevision === undefined ? {} : { expectedRevision }),
      payload,
    })) as TransportReply | undefined;
    if (!response?.ok)
      throw new Error(response?.code ?? "SURI_CHAIN_CAPABILITY_INVALID");
    if (
      type === "host.get" &&
      typeof response.chainContext?.runtimeId === "string"
    )
      this.runtimeId = response.chainContext.runtimeId;
    if (type === "stage.register")
      this.registrationId = response.registrationId;
    const receipt = response.receipt;
    if (!receipt) return response;
    if (receipt.status === "indeterminate")
      throw new Error("SURI_DISPATCH_INDETERMINATE");
    if (receipt.status === "rejected")
      throw new Error(receipt.error?.code ?? "SURI_REJECTED");
    return { ...(receipt.result ?? {}), receiptStatus: receipt.status };
  }
  async preflight(plan: ChainPlan, stage: Stage) {
    this.plan = plan;
    this.stageId = stage.id;
    if (stage.provider !== "openai-codex")
      throw new Error("PROVIDER_NOT_AUTHORIZED");
    const host = await this.command("host.get", {});
    if (host.runtimeMode !== "live" && host.runtimeMode !== "simulated")
      throw new Error("SURI_UNAVAILABLE");
  }
  async dispatch(
    plan: ChainPlan,
    stage: Stage,
    attemptId: string,
  ): Promise<StageReceipt> {
    const sessionId = randomUUID();
    const prompt = boundedPrompt(plan, stage, attemptId, sessionId);
    await this.command("stage.register", {
      attemptId,
      targetSessionId: sessionId,
      provider: stage.provider,
      modelId: stage.modelId,
      thinking: stage.thinking,
      promptHash: digest(prompt),
      expiresAt: Date.now() + 5 * 60_000,
      commandSequence: [
        "session.create",
        "model.set",
        "thinking.set",
        "run.submit",
      ],
    });
    const session = await this.command("session.create", {
      name: `Chain · ${stage.id}`,
    });
    if (session.id !== sessionId)
      throw new Error("SURI_TARGET_SESSION_MISMATCH");
    const selectedModel = await this.command(
      "model.set",
      { provider: stage.provider, id: stage.modelId },
      sessionId,
      session.revision,
    );
    if (
      selectedModel.provider !== stage.provider ||
      selectedModel.id !== stage.modelId ||
      !Number.isInteger(selectedModel.revision)
    )
      throw new Error("SURI_EFFECTIVE_MODEL_MISMATCH");
    const selectedThinking = await this.command(
      "thinking.set",
      { level: stage.thinking },
      sessionId,
      selectedModel.revision,
    );
    if (
      selectedThinking.level !== stage.thinking ||
      !Number.isInteger(selectedThinking.revision)
    )
      throw new Error("SURI_EFFECTIVE_THINKING_MISMATCH");
    const submitted = await this.command(
      "run.submit",
      { mode: "prompt", text: prompt, attachmentIds: [] },
      sessionId,
    );
    if (!["accepted", "completed"].includes(submitted.receiptStatus!))
      throw new Error("SURI_DISPATCH_INDETERMINATE");
    return {
      attemptId,
      sessionId,
      adapter: "suri",
      provider: stage.provider,
      modelId: stage.modelId,
      thinking: stage.thinking,
    };
  }
  async reconcile() {
    return null;
  }
  async observe(): Promise<StageResult | null> {
    return null;
  }
  async cancel(receipt: StageReceipt) {
    await this.command("run.cancel", {}, receipt.sessionId);
  }
}
