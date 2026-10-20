import { z } from "zod";
import { BuildIdSchema } from "./updates.js";
import { CheckpointSchema } from "./update-checkpoint.js";
const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const client = z.uuid();
export const UpdateCommandPayloads = {
  "updates.client": z.strictObject({
    clientInstanceId: client,
    surface: z.enum(["browser", "native"]),
    loadedUiId: BuildIdSchema.nullable(),
    mode: z.enum(["follow", "pinned"]),
    shellContract: z.number().int().min(1).max(2).optional(),
  }),
  "host.restart.approve": z.strictObject({
    clientInstanceId: client,
    targetBuildId: BuildIdSchema,
    generation: revision,
    mode: z.enum(["now", "when-idle"]),
    confirm: z.literal(true),
  }),
  "host.restart.cancel": z.strictObject({
    clientInstanceId: client,
    operationId: z.uuid(),
  }),
  "host.restart.checkpoint": z.strictObject({
    clientInstanceId: client,
    operationId: z.uuid(),
    barrierId: z.uuid(),
    expectedCheckpointRevision: revision,
    checkpoint: CheckpointSchema,
  }),
  "host.restart.ack": z.strictObject({
    clientInstanceId: client,
    operationId: z.uuid(),
    barrierId: z.uuid(),
    checkpointRevision: revision,
  }),
  "ui.rendezvous": z.strictObject({
    clientInstanceId: client,
    requestId: z.uuid(),
    checkpoint: CheckpointSchema,
    expectedCheckpointRevision: revision,
  }),
  "ui.prepare": z.strictObject({
    buildId: BuildIdSchema,
    expectedUpdateRevision: revision,
    clientInstanceId: client,
  }),
  "ui.checkpoint": z.strictObject({
    operationId: z.uuid(),
    clientInstanceId: client,
    checkpoint: CheckpointSchema,
    expectedCheckpointRevision: revision,
  }),
  "ui.activate": z.strictObject({
    operationId: z.uuid(),
    buildId: BuildIdSchema,
    clientInstanceId: client,
    expectedUpdateRevision: revision,
    checkpointRevision: revision,
  }),
  "ui.ready": z.strictObject({
    operationId: z.uuid().nullable(),
    clientInstanceId: client,
    buildId: BuildIdSchema,
    checkpointRevision: revision,
    hostInstanceId: z.uuid(),
    catalogSeq: revision,
    sessionSeq: revision.optional(),
  }),
  "ui.failed": z.strictObject({
    operationId: z.uuid().nullable(),
    clientInstanceId: client,
    buildId: BuildIdSchema,
    code: z.enum(["UI_MOUNT_FAILED", "UI_READY_TIMEOUT", "UI_ASSET_MISSING"]),
  }),
  "ui.follow": z.strictObject({ clientInstanceId: client }),
  "ui.pin": z.strictObject({
    clientInstanceId: client,
    buildId: BuildIdSchema,
  }),
  "ui.rollback": z.strictObject({
    clientInstanceId: client,
    expectedUpdateRevision: revision,
    target: z.enum(["previous", "packaged"]),
  }),
} as const;
export type UpdateCommandType = keyof typeof UpdateCommandPayloads;
export const isUpdateCommand = (type: string): type is UpdateCommandType =>
  Object.hasOwn(UpdateCommandPayloads, type);
