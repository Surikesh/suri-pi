import { SuriError } from "../../protocol/src/index.js";

export type ReviewQueueCapability = "supported" | "capability_unavailable";
export type ReviewQueueCapabilities = {
  schema: 1;
  adapterId: string;
  operations: Record<
    | "launch_fresh"
    | "resume_same"
    | "prompt_receipt"
    | "durable_cursor"
    | "context_usage"
    | "compact_receipt"
    | "terminal_compaction_event"
    | "suspend_writer"
    | "resume_writer"
    | "prove_quiescent"
    | "launch_reviewer_readonly"
    | "immutable_candidate"
    | "abort"
    | "close"
    | "bounded_result",
    ReviewQueueCapability
  >;
};

/**
 * Read-only capability discovery for the queue coordinator. This performs no
 * provider request and deliberately reports security properties that Pi RPC
 * cannot currently enforce as unavailable. A caller must fail closed rather
 * than infer them from idle state, process existence, or model prose.
 */
export function reviewQueueCapabilities(
  runtimeVersion: string,
): ReviewQueueCapabilities {
  const unavailable: ReviewQueueCapability = "capability_unavailable";
  return {
    schema: 1,
    adapterId: `suri-pi-review-queue/1;pi/${runtimeVersion}`,
    operations: {
      launch_fresh: unavailable,
      resume_same: unavailable,
      prompt_receipt: unavailable,
      durable_cursor: unavailable,
      context_usage: unavailable,
      compact_receipt: unavailable,
      terminal_compaction_event: unavailable,
      suspend_writer: unavailable,
      resume_writer: unavailable,
      prove_quiescent: unavailable,
      launch_reviewer_readonly: unavailable,
      immutable_candidate: unavailable,
      abort: unavailable,
      close: unavailable,
      bounded_result: unavailable,
    },
  };
}

export function requireReviewQueueCapabilities(
  capabilities: ReviewQueueCapabilities,
  required: Array<keyof ReviewQueueCapabilities["operations"]>,
): void {
  const missing = required.filter(
    (name) => capabilities.operations[name] !== "supported",
  );
  if (missing.length)
    throw new SuriError(
      "RUNTIME_UNSUPPORTED",
      `Review queue capability unavailable: ${missing.join(", ")}.`,
    );
}
