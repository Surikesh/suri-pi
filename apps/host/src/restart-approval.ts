import { z } from "zod";
import { BuildIdSchema } from "../../../packages/protocol/src/updates.js";
import type { RestartHandoffs } from "./restart-handoff.js";

export const RestartApprovalSchema = z.strictObject({
  operationId: z.uuid(),
  targetBuildId: BuildIdSchema,
  uiBuildId: BuildIdSchema,
  fromInstanceId: z.uuid(),
  profileId: z.uuid(),
  origin: z.string().url(),
  generation: z.number().int().nonnegative(),
  approvedAt: z.number().int(),
  expiresAt: z.number().int(),
  phase: z.enum([
    "waiting",
    "preflight",
    "checkpoints",
    "dispatching",
    "admitted",
    "completed",
    "cancelled",
    "failed",
  ]),
  code: z.string().max(80).nullable(),
  barrierAt: z.number().int().nullable(),
  barrierId: z.uuid().nullable().default(null),
});
export type RestartApproval = z.infer<typeof RestartApprovalSchema>;
export type WorkState = {
  count: number;
  blockers: { kind: string; count: number }[];
};
export class RestartFailure extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
export type RestartHooks = {
  instanceId: string;
  profileId: string;
  runningBuildId?: string;
  origin: () => string;
  target: () => { buildId: string; generation: number } | null;
  uiBuildId: () => string;
  work: () => WorkState;
  clients: () => string[];
  preflight: (id: string) => Promise<void>;
  dispatch: (approval: RestartApproval) => Promise<void>;
  handoffs: RestartHandoffs;
};
