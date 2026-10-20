import type { spawn } from "node:child_process";

type QueueRole = "implementer" | "reviewer";
export type QueueAuthority = Readonly<{
  sourceHostSessionId: string;
  sourceChannelId: string;
  workspaceId: string;
  repository: string;
  runtimeId: string;
}>;
export type QueueReceipt = Readonly<{
  schema: 1;
  operation: string;
  key: string;
  payloadDigest: string;
  status: "accepted" | "completed" | "unknown";
  sessionId?: string;
  data?: Record<string, unknown>;
}>;

export type Session = {
  id: string;
  role: QueueRole;
  epoch: number;
  repository: string;
  candidate?: string;
  scratch?: string;
  hostWorkerSessionId: string;
  authority: QueueAuthority;
  writer: boolean;
  inFlightMutations: number;
  mutationTail: Promise<void>;
  activeProcesses: Set<ReturnType<typeof spawn>>;
  closed: boolean;
};
