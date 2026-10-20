import { z } from "zod";
const id = z.uuid();
const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const CheckpointSchema = z.strictObject({
  schema: z.literal(1),
  selectedProjectId: id.nullable(),
  selectedWorkspaceId: id.nullable(),
  selectedSessionId: id.nullable(),
  draft: z.strictObject({
    text: z.string().max(4 * 1024 * 1024),
    attachmentIds: z.array(id).max(1000),
    revision,
    outboxIds: z.array(id).max(1000),
  }),
  expandedIds: z.array(z.string().min(1).max(256)).max(10_000),
  anchor: z.strictObject({
    messageId: z.string().max(256).nullable(),
    blockId: z.string().max(256).nullable(),
    offset: z.number().finite().min(-1_000_000).max(1_000_000),
    bottomFollow: z.boolean(),
  }),
  layout: z.strictObject({
    sidebarOpen: z.boolean(),
    detailsOpen: z.boolean(),
    focus: z.enum(["composer", "transcript", "none"]),
  }),
});
export type UpdateCheckpoint = z.infer<typeof CheckpointSchema>;
export const CheckpointRecordSchema = z.strictObject({
  clientInstanceId: id,
  authClientId: id,
  operationId: id,
  revision,
  checkpoint: CheckpointSchema,
});
export type CheckpointRecord = z.infer<typeof CheckpointRecordSchema>;
