import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { resolve } from "node:path";
import {
  ReviewQueueRuntime,
  ReviewQueueRuntimeError,
} from "./review-queue-runtime.js";

export type QueueWorkerRole = "implementer" | "reviewer";
export type QueueWorkerBinding = Readonly<{
  role: QueueWorkerRole;
  sessionId: string;
  epoch: number;
}>;

type Packet = {
  protocol?: unknown;
  operation?: unknown;
  sessionId?: unknown;
  epoch?: unknown;
  target?: unknown;
  bytes?: unknown;
  executable?: unknown;
  args?: unknown;
};

/**
 * Host-owned queue worker profile. Pi is launched with discovery and all built-in
 * tools disabled; the sole explicit extension talks to this handler over the
 * existing authenticated private descriptor. Consequently a model has no direct
 * shell, interpreter, command-builder, descendant-process, direct write,
 * project extension, skill, or context-file capability.
 */
export class ReviewQueueWorkerProfile {
  readonly extension: string;

  constructor(
    private runtime: ReviewQueueRuntime,
    extension: string,
  ) {
    this.extension = resolve(extension);
  }

  async available(): Promise<boolean> {
    if (process.platform !== "darwin") return false;
    try {
      await Promise.all([
        access("/usr/bin/sandbox-exec", constants.X_OK),
        access(this.extension, constants.R_OK),
      ]);
      return true;
    } catch {
      return false;
    }
  }

  args(role: QueueWorkerRole): string[] {
    const tools =
      role === "implementer"
        ? "queue_read,queue_write,queue_exec"
        : "queue_read,queue_result";
    return [
      "--no-extensions",
      "--extension",
      this.extension,
      "--no-skills",
      "--no-prompt-templates",
      "--no-context-files",
      "--no-builtin-tools",
      "--tools",
      tools,
      "--offline",
      "--no-approve",
    ];
  }

  async handle(binding: QueueWorkerBinding, value: unknown) {
    const packet = value as Packet;
    if (
      !packet ||
      packet.protocol !== "suri-review-queue-worker-v1" ||
      typeof packet.operation !== "string"
    )
      throw new ReviewQueueRuntimeError(
        "worker_capability_invalid",
        "Queue worker capability did not match its host binding.",
      );

    if (packet.operation === "bind")
      return { ok: true, role: binding.role } as const;
    if (packet.operation === "read") {
      if (typeof packet.target !== "string")
        return this.denied("worker_request_invalid");
      return {
        ok: true,
        result: await this.runtime.read(binding.sessionId, packet.target),
      };
    }
    if (packet.operation === "write") {
      if (binding.role !== "implementer")
        return this.denied("reviewer_write_denied");
      if (typeof packet.target !== "string" || typeof packet.bytes !== "string")
        return this.denied("worker_request_invalid");
      await this.runtime.mutate(
        binding.sessionId,
        binding.epoch,
        packet.target,
        packet.bytes,
      );
      return { ok: true };
    }
    if (packet.operation === "result") {
      if (binding.role !== "reviewer") return this.denied("role_denied");
      if (typeof packet.target !== "string" || typeof packet.bytes !== "string")
        return this.denied("worker_request_invalid");
      await this.runtime.writeReviewerResult(
        binding.sessionId,
        packet.target,
        packet.bytes,
      );
      return { ok: true };
    }
    if (packet.operation === "exec") {
      if (binding.role !== "implementer")
        return this.denied("reviewer_execute_denied");
      if (
        typeof packet.executable !== "string" ||
        !Array.isArray(packet.args) ||
        !packet.args.every((arg) => typeof arg === "string")
      )
        return this.denied("worker_request_invalid");
      return {
        ok: true,
        result: await this.runtime.execute(
          binding.sessionId,
          binding.epoch,
          packet.executable,
          packet.args as string[],
        ),
      };
    }
    return this.denied("worker_operation_denied");
  }

  private denied(category: string) {
    return { ok: false, category } as const;
  }
}
