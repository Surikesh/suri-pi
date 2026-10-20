import { spawn } from "node:child_process";
import type { ChainPlan, Stage } from "./chain-types.js";

export type Exec = (
  command: string,
  args: string[],
  options?: { cwd?: string },
) => Promise<{ code: number; stdout: string; stderr: string }>;
export const exec: Exec = (command, args, options) =>
  new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options?.cwd,
      shell: false,
      env: process.env,
    });
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (value) => {
      stdout += value;
    });
    child.stderr.on("data", (value) => {
      stderr += value;
    });
    child.on("error", () =>
      resolve({ code: 1, stdout, stderr: "spawn failed" }),
    );
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
// Fields are typed as the receipts consume them; the CLI payload is unchecked.
type HerdrAgent = {
  workspace_id: string;
  tab_id: string;
  session_id: string;
  pane_id: string;
  name: string;
  model_id?: unknown;
  thinking: Stage["thinking"];
};
type HerdrReply = {
  result?: { pane?: { pane_id: string }; agent?: HerdrAgent };
};
export const json = (value: string) => JSON.parse(value) as HerdrReply;
export const boundedPrompt = (
  plan: ChainPlan,
  stage: Stage,
  attemptId: string,
  sessionId?: string,
) =>
  [
    `Chain request ${plan.requestId}; TM task ${plan.taskId}; stage ${stage.id}; attempt ${attemptId}${sessionId ? `; session ${sessionId}` : ""}.`,
    stage.instruction,
    `Owned paths: ${stage.ownedPaths.join(", ") || "read-only"}.`,
    `Acceptance: ${stage.acceptance.join(" | ")}.`,
    sessionId
      ? `Finish by calling model_chain_result exactly once with requestId=${plan.requestId}, attemptId=${attemptId}, sessionId=${sessionId}. For review stages, begin summary with APPROVED or REJECTED and use a non-completed verdict when rejected.`
      : "Return a bounded result through the chain runtime; do not start another stage.",
  ].join("\n");
