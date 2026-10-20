export type RuntimeStartupTrigger =
  | "explicit-create"
  | "explicit-resume"
  | "submit"
  | "context"
  | "models"
  | "commands"
  | "other";
export type RuntimeStartupStage =
  "probe" | "spawn" | "extension-load" | "rpc-readiness" | "model-apply";
export type RuntimeStartupDiagnostic = Readonly<{
  attemptId: string;
  trigger: RuntimeStartupTrigger;
  stage: RuntimeStartupStage;
  category:
    | "enotty"
    | "descriptor-in-use"
    | "extension-load"
    | "malformed-rpc"
    | "timeout"
    | "spawn"
    | "unknown";
  readinessReached: boolean;
  elapsed: "under-1s" | "1-5s" | "5-15s" | "over-15s";
  exitCode?: number;
  signal?: string;
  spawnCode?: string;
}>;
