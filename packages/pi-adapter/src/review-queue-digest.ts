import { createHash } from "node:crypto";
import type { QueueAuthority } from "./review-queue-types.js";

function stable(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`)
    .join(",")}}`;
}
export const digest = (value: unknown) =>
  createHash("sha256").update(stable(value)).digest("hex");
export const authorityKey = (authority: QueueAuthority) =>
  digest([
    authority.sourceHostSessionId,
    authority.sourceChannelId,
    authority.workspaceId,
    authority.repository,
    authority.runtimeId,
  ]);

export function hashRecord(
  hash: ReturnType<typeof createHash>,
  kind: string,
  path: string,
  data: Buffer,
) {
  const name = Buffer.from(path, "utf8");
  const lengths = Buffer.alloc(16);
  lengths.writeBigUInt64BE(BigInt(name.length), 0);
  lengths.writeBigUInt64BE(BigInt(data.length), 8);
  hash.update(kind).update(lengths).update(name).update(data);
}
