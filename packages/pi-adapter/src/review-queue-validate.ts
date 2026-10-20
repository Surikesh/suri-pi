import { ReviewQueueRuntimeError } from "./review-queue-error.js";
import type { QueueAuthority } from "./review-queue-types.js";

export function sourceKey(source: QueueAuthority) {
  return `${source.sourceHostSessionId}\0${source.sourceChannelId}`;
}
export function requiredString(value: unknown) {
  if (typeof value !== "string" || !value || value.length > 4096)
    throw new ReviewQueueRuntimeError(
      "queue_control_invalid",
      "A bounded string is required.",
    );
  return value;
}
export function requiredUuid(value: unknown) {
  const result = requiredString(value);
  if (!/^[0-9a-f-]{36}$/i.test(result))
    throw new ReviewQueueRuntimeError(
      "queue_control_invalid",
      "A UUID host session is required.",
    );
  return result;
}
export function requiredEpoch(value: unknown) {
  if (!Number.isSafeInteger(value) || Number(value) <= 0)
    throw new ReviewQueueRuntimeError(
      "queue_control_invalid",
      "A positive fencing epoch is required.",
    );
  return Number(value);
}
export function requiredDigest(value: unknown) {
  const result = requiredString(value);
  if (!/^[a-f0-9]{64}$/.test(result))
    throw new ReviewQueueRuntimeError(
      "queue_control_invalid",
      "A canonical candidate digest is required.",
    );
  return result;
}
