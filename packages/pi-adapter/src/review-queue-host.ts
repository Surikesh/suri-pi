import { join } from "node:path";
import {
  ReviewQueueRuntime,
  ReviewQueueRuntimeError,
  type QueueAuthority,
  type QueueReceipt,
} from "./review-queue-runtime.js";
import {
  ReviewQueueWorkerProfile,
  type QueueWorkerBinding,
  type QueueWorkerRole,
} from "./review-queue-worker.js";

import {
  requiredDigest,
  requiredEpoch,
  requiredString,
  requiredUuid,
  sourceKey,
} from "./review-queue-validate.js";
export const REVIEW_QUEUE_CONTROL_PROTOCOL =
  "suri-review-queue-control-v1" as const;

type ReviewQueueSource = QueueAuthority;
type ControlPacket = {
  protocol?: unknown;
  operation?: unknown;
  key?: unknown;
  targetSessionId?: unknown;
  epoch?: unknown;
  implementerSessionId?: unknown;
  candidateRoot?: unknown;
  candidateDigest?: unknown;
};
export type QueueHostLaunch = Readonly<{
  targetSessionId: string;
  role: QueueWorkerRole;
  runtimeSessionId: string;
  epoch: number;
  launchKey: string;
  profileArgs: string[];
  source: ReviewQueueSource;
}>;
type LaunchHostSession = (input: QueueHostLaunch) => Promise<unknown>;
type InspectHostSession = (targetSessionId: string) => {
  exists: boolean;
  active: boolean;
};
type HostBinding = QueueWorkerBinding & {
  hostSessionId: string;
  repository: string;
  runtimeId: string;
  workspaceId: string;
  sourceHostSessionId: string;
  sourceChannelId: string;
  launchKey: string;
};

/** Authenticated host-side control plane for exact fenced queue workers. */
export class ReviewQueueHost {
  private byHostSession = new Map<string, HostBinding>();
  private hostByRuntimeSession = new Map<string, string>();
  private revokedSources = new Set<string>();

  constructor(
    readonly runtime: ReviewQueueRuntime,
    readonly profile: ReviewQueueWorkerProfile,
    private readonly scratchRoot: string,
    private readonly launchHostSession: LaunchHostSession,
    private readonly inspectHostSession: InspectHostSession = () => ({
      exists: false,
      active: false,
    }),
  ) {}

  async capabilities() {
    const available =
      (await this.profile.available()) && (await this.runtime.available());
    const state = available ? "supported" : "capability_unavailable";
    return {
      schema: 1 as const,
      adapterId: "suri-pi-review-queue-host/2",
      workerProfile: state,
      operations: {
        launch_fresh: state,
        suspend_writer: state,
        resume_writer: state,
        prove_quiescent: state,
        launch_reviewer_readonly: state,
        immutable_candidate: state,
        mediated_subprocess: state,
        reviewer_result: state,
      },
    };
  }

  binding(hostSessionId: string): QueueWorkerBinding | undefined {
    const value = this.byHostSession.get(hostSessionId);
    if (!value) return undefined;
    return { role: value.role, sessionId: value.sessionId, epoch: value.epoch };
  }
  args(hostSessionId: string): string[] | undefined {
    const value = this.byHostSession.get(hostSessionId);
    return value ? this.profile.args(value.role) : undefined;
  }
  async handleWorker(hostSessionId: string, packet: unknown) {
    const binding = this.binding(hostSessionId);
    if (!binding)
      throw new ReviewQueueRuntimeError(
        "worker_binding_missing",
        "The queue worker has no live host binding.",
      );
    try {
      return await this.profile.handle(binding, packet);
    } catch (error) {
      if (error instanceof ReviewQueueRuntimeError)
        return this.denied(error.category);
      return this.denied("queue_worker_failed");
    }
  }

  async handleControl(source: ReviewQueueSource, value: unknown) {
    const packet = value as ControlPacket;
    if (
      !packet ||
      packet.protocol !== REVIEW_QUEUE_CONTROL_PROTOCOL ||
      typeof packet.operation !== "string"
    )
      return this.denied("queue_control_invalid");
    try {
      if (this.revokedSources.has(sourceKey(source)))
        return this.denied("source_authority_revoked");
      if (packet.operation === "capabilities")
        return { ok: true, capabilities: await this.capabilities() };
      if (
        !(await this.profile.available()) ||
        !(await this.runtime.available())
      )
        return this.denied("capability_unavailable");
      if (packet.operation === "launch_implementer")
        return await this.launchImplementer(source, packet);
      if (packet.operation === "launch_reviewer")
        return await this.launchReviewer(source, packet);
      if (packet.operation === "suspend_writer")
        return this.fence(source, packet, "suspend");
      if (packet.operation === "resume_writer")
        return this.fence(source, packet, "resume");
      if (packet.operation === "prove_quiescent")
        return this.fence(source, packet, "prove");
      return this.denied("queue_control_operation_denied");
    } catch (error) {
      if (error instanceof ReviewQueueRuntimeError)
        return this.denied(error.category);
      return this.denied("queue_control_failed");
    }
  }

  sourceExited(sourceHostSessionId: string, sourceChannelId: string) {
    this.revokedSources.add(`${sourceHostSessionId}\0${sourceChannelId}`);
    const revoked: HostBinding[] = [];
    for (const [hostSessionId, binding] of this.byHostSession) {
      if (
        binding.sourceHostSessionId !== sourceHostSessionId ||
        binding.sourceChannelId !== sourceChannelId
      )
        continue;
      this.byHostSession.delete(hostSessionId);
      this.hostByRuntimeSession.delete(binding.sessionId);
      revoked.push(binding);
      try {
        this.runtime.close(binding.sessionId);
      } catch {
        // Best effort: the runtime session may already be closed; revocation proceeds either way.
      }
    }
    return revoked;
  }
  workerExited(hostSessionId: string) {
    const binding = this.byHostSession.get(hostSessionId);
    if (!binding) return undefined;
    this.byHostSession.delete(hostSessionId);
    this.hostByRuntimeSession.delete(binding.sessionId);
    try {
      this.runtime.close(binding.sessionId);
    } catch {
      // Best effort: the runtime session may already be closed; the binding is released either way.
    }
    return binding;
  }

  private async launchImplementer(
    source: ReviewQueueSource,
    packet: ControlPacket,
  ) {
    const key = requiredString(packet.key);
    const targetSessionId = requiredUuid(packet.targetSessionId);
    const epoch = requiredEpoch(packet.epoch);
    this.assertTargetAvailable(source, targetSessionId, "implementer", key);
    const receipt = await this.runtime.launchImplementer(key, {
      repository: source.repository,
      epoch,
      authority: source,
      hostWorkerSessionId: targetSessionId,
    });
    if (!receipt.sessionId)
      throw new ReviewQueueRuntimeError(
        "worker_receipt_invalid",
        "Implementer launch did not mint a runtime session.",
      );
    return this.launchBoundWorker(
      source,
      targetSessionId,
      "implementer",
      epoch,
      key,
      receipt,
    );
  }

  private async launchReviewer(
    source: ReviewQueueSource,
    packet: ControlPacket,
  ) {
    const key = requiredString(packet.key);
    const targetSessionId = requiredUuid(packet.targetSessionId);
    const implementerSessionId = requiredString(packet.implementerSessionId);
    const candidateRoot = requiredString(packet.candidateRoot);
    if (candidateRoot !== source.repository)
      throw new ReviewQueueRuntimeError(
        "path_escape",
        "The reviewer candidate must be the authenticated source workspace.",
      );
    const candidateDigest = requiredDigest(packet.candidateDigest);
    const epoch = requiredEpoch(packet.epoch);
    this.assertTargetAvailable(source, targetSessionId, "reviewer", key);
    const receipt = await this.runtime.launchReviewer(key, {
      implementerSessionId,
      candidateRoot,
      candidateDigest,
      scratchRoot: join(this.scratchRoot, targetSessionId),
      epoch,
      authority: source,
      hostWorkerSessionId: targetSessionId,
    });
    if (!receipt.sessionId)
      throw new ReviewQueueRuntimeError(
        "worker_receipt_invalid",
        "Reviewer launch did not mint a runtime session.",
      );
    return this.launchBoundWorker(
      source,
      targetSessionId,
      "reviewer",
      epoch,
      key,
      receipt,
    );
  }

  private assertTargetAvailable(
    source: ReviewQueueSource,
    targetSessionId: string,
    role: QueueWorkerRole,
    launchKey: string,
  ) {
    const bound = this.byHostSession.get(targetSessionId);
    if (bound) {
      if (
        bound.role === role &&
        bound.launchKey === launchKey &&
        this.sameSource(bound, source)
      )
        return;
      throw new ReviewQueueRuntimeError(
        "target_session_collision",
        "The requested host session is already owned.",
      );
    }
    const existing = this.inspectHostSession(targetSessionId);
    if (existing.exists)
      throw new ReviewQueueRuntimeError(
        "target_session_collision",
        existing.active
          ? "The requested host session is active."
          : "The requested host session already exists.",
      );
  }

  private async launchBoundWorker(
    source: ReviewQueueSource,
    hostSessionId: string,
    role: QueueWorkerRole,
    epoch: number,
    launchKey: string,
    receipt: QueueReceipt,
  ) {
    const sessionId = receipt.sessionId!;
    if (this.revokedSources.has(sourceKey(source))) {
      try {
        this.runtime.close(sessionId);
      } catch {
        // Best effort: the runtime session may already be closed; the authority error below is thrown either way.
      }
      throw new ReviewQueueRuntimeError(
        "source_authority_revoked",
        "The authenticated source channel was revoked during launch.",
      );
    }
    const oldHost = this.hostByRuntimeSession.get(sessionId);
    if (oldHost) {
      const old = this.byHostSession.get(oldHost);
      if (
        oldHost !== hostSessionId ||
        !old ||
        old.launchKey !== launchKey ||
        old.role !== role ||
        !this.sameSource(old, source)
      )
        throw new ReviewQueueRuntimeError(
          "request_payload_mismatch",
          "The idempotent worker launch changed its host authority.",
        );
      return { ok: true, receipt, hostSessionId, duplicate: true };
    }
    if (this.byHostSession.has(hostSessionId))
      throw new ReviewQueueRuntimeError(
        "target_session_collision",
        "The host session is already bound to another queue worker.",
      );
    const binding: HostBinding = {
      hostSessionId,
      role,
      sessionId,
      epoch,
      repository: source.repository,
      runtimeId: source.runtimeId,
      workspaceId: source.workspaceId,
      sourceHostSessionId: source.sourceHostSessionId,
      sourceChannelId: source.sourceChannelId,
      launchKey,
    };
    this.byHostSession.set(hostSessionId, binding);
    this.hostByRuntimeSession.set(sessionId, hostSessionId);
    try {
      const hostReceipt = await this.launchHostSession({
        targetSessionId: hostSessionId,
        role,
        runtimeSessionId: sessionId,
        epoch,
        launchKey,
        profileArgs: this.profile.args(role),
        source,
      });
      return { ok: true, receipt, hostSessionId, hostReceipt };
    } catch (error) {
      this.byHostSession.delete(hostSessionId);
      this.hostByRuntimeSession.delete(sessionId);
      try {
        this.runtime.close(sessionId);
      } catch {
        // Best effort: the runtime session may already be closed; the original error is rethrown below.
      }
      throw error;
    }
  }

  private fence(
    source: ReviewQueueSource,
    packet: ControlPacket,
    action: "suspend" | "resume" | "prove",
  ) {
    const sessionId = requiredString(packet.implementerSessionId);
    const epoch = requiredEpoch(packet.epoch);
    const receipt =
      action === "suspend"
        ? this.runtime.suspendWriter(sessionId, epoch, source)
        : action === "resume"
          ? this.runtime.resumeWriter(sessionId, epoch, source)
          : this.runtime.proveQuiescent(sessionId, epoch, source);
    return { ok: true, receipt };
  }
  private sameSource(binding: HostBinding, source: ReviewQueueSource) {
    return (
      binding.sourceHostSessionId === source.sourceHostSessionId &&
      binding.sourceChannelId === source.sourceChannelId &&
      binding.workspaceId === source.workspaceId &&
      binding.repository === source.repository &&
      binding.runtimeId === source.runtimeId
    );
  }
  private denied(category: string) {
    return { ok: false, category } as const;
  }
}
