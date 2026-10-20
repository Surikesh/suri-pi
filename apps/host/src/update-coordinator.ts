import { randomUUID } from "node:crypto";
import { z } from "zod";
import { join } from "node:path";
import { BuildIdSchema } from "../../../packages/protocol/src/updates.js";
import type { UpdateCheckpoint } from "../../../packages/protocol/src/update-checkpoint.js";
import { UpdateStateStore } from "./update-state.js";
import { UpdateCheckpoints } from "./update-checkpoint.js";
import { validatePrivateArtifact } from "./update-artifacts.js";
export class UpdateTransitionFailure extends Error {
  constructor(
    readonly code:
      | "UPDATE_CONFLICT"
      | "UNAUTHORIZED"
      | "CONTRACT_INCOMPATIBLE"
      | "UI_READY_TIMEOUT"
      | "CANDIDATE_INTEGRITY"
      | "CHECKPOINT_CONFLICT",
  ) {
    super(code);
  }
}
type Client = { auth: string; seen: number };
export class UpdateCoordinator {
  private readonly clients = new Map<string, Client>();
  private readonly checkpoints: UpdateCheckpoints;
  constructor(
    readonly root: string,
    readonly state: UpdateStateStore,
    readonly hostInstanceId: string,
    private readonly now: () => number = Date.now,
  ) {
    this.checkpoints = new UpdateCheckpoints(root);
  }
  register(client: string, auth: string) {
    z.uuid().parse(client);
    z.uuid().parse(auth);
    const previous = this.clients.get(client);
    if (previous && previous.auth !== auth)
      throw new UpdateTransitionFailure("UNAUTHORIZED");
    this.clients.set(client, { auth, seen: this.now() });
  }
  private lease(client: string, auth: string) {
    const registered = this.clients.get(client);
    if (
      !registered ||
      registered.auth !== auth ||
      this.now() - registered.seen >= 45_000
    )
      throw new UpdateTransitionFailure("UNAUTHORIZED");
  }
  private trial(operation: string, client: string, auth: string) {
    this.lease(client, auth);
    const trial = this.state.snapshot().trial;
    if (
      !trial ||
      trial.operationId !== operation ||
      trial.clientInstanceId !== client ||
      trial.authClientId !== auth
    )
      throw new UpdateTransitionFailure("UPDATE_CONFLICT");
    return trial;
  }
  async prepare(
    buildId: string,
    expectedRevision: number,
    client: string,
    auth: string,
  ) {
    this.lease(client, auth);
    BuildIdSchema.parse(buildId);
    const manifest = await validatePrivateArtifact(
      join(this.root, "ui-builds", buildId),
      "ui",
      buildId,
    );
    if (
      manifest.identity.compatibility.hostMin > 2 ||
      manifest.identity.compatibility.hostMax < 2
    )
      throw new UpdateTransitionFailure("CONTRACT_INCOMPATIBLE");
    const operationId = randomUUID();
    return this.state.change(expectedRevision, (state) => {
      if (
        state.trial ||
        state.rejected.some((entry) => entry.buildId === buildId)
      )
        throw new UpdateTransitionFailure("UPDATE_CONFLICT");
      state.trial = {
        operationId,
        clientInstanceId: client,
        authClientId: auth,
        buildId,
        fromId: state.activeUiId,
        phase: "prepared",
        checkpointRevision: null,
        deadline: this.now() + 60_000,
      };
    });
  }
  async checkpoint(
    operation: string,
    client: string,
    auth: string,
    expectedCheckpointRevision: number,
    checkpoint: UpdateCheckpoint,
  ) {
    const trial = this.trial(operation, client, auth);
    if (trial.phase !== "prepared")
      throw new UpdateTransitionFailure("UPDATE_CONFLICT");
    const record = await this.checkpoints.save(
      client,
      auth,
      operation,
      expectedCheckpointRevision,
      checkpoint,
    );
    const revision = this.state.snapshot().revision;
    return this.state.change(revision, (state) => {
      if (
        state.trial?.operationId !== operation ||
        state.trial.phase !== "prepared"
      )
        throw new UpdateTransitionFailure("UPDATE_CONFLICT");
      state.trial.checkpointRevision = record.revision;
    });
  }
  async activate(
    operation: string,
    buildId: string,
    client: string,
    auth: string,
    expectedRevision: number,
    checkpointRevision: number,
  ) {
    const trial = this.trial(operation, client, auth);
    if (
      trial.buildId !== buildId ||
      trial.phase !== "prepared" ||
      trial.checkpointRevision !== checkpointRevision
    )
      throw new UpdateTransitionFailure("CHECKPOINT_CONFLICT");
    // Revalidate exact inventory immediately before trial, never use discovery as authority.
    await validatePrivateArtifact(
      join(this.root, "ui-builds", buildId),
      "ui",
      buildId,
    );
    return this.state.change(expectedRevision, (state) => {
      if (state.trial?.operationId !== operation)
        throw new UpdateTransitionFailure("UPDATE_CONFLICT");
      state.trial.phase = "navigating";
      state.trial.deadline = this.now() + 60_000;
    });
  }
  async ready(
    operation: string,
    buildId: string,
    client: string,
    auth: string,
    checkpointRevision: number,
    hostInstanceId: string,
    catalogSeq: number,
  ) {
    const trial = this.trial(operation, client, auth);
    if (
      !Number.isSafeInteger(catalogSeq) ||
      catalogSeq < 0 ||
      hostInstanceId !== this.hostInstanceId ||
      trial.phase !== "navigating" ||
      trial.buildId !== buildId ||
      trial.checkpointRevision !== checkpointRevision
    )
      throw new UpdateTransitionFailure("UPDATE_CONFLICT");
    if (trial.deadline <= this.now())
      throw new UpdateTransitionFailure("UI_READY_TIMEOUT");
    return this.state.change(this.state.snapshot().revision, (state) => {
      if (state.trial?.operationId !== operation)
        throw new UpdateTransitionFailure("UPDATE_CONFLICT");
      if (state.activeUiId !== buildId)
        state.previousKnownGoodUiId =
          state.activeUiId && state.knownGood.includes(state.activeUiId)
            ? state.activeUiId
            : state.previousKnownGoodUiId;
      state.activeUiId = buildId;
      if (!state.knownGood.includes(buildId)) state.knownGood.push(buildId);
      state.trial = null;
    });
  }
  async failed(
    operation: string,
    buildId: string,
    client: string,
    auth: string,
    code: "UI_MOUNT_FAILED" | "UI_READY_TIMEOUT" | "UI_ASSET_MISSING",
  ) {
    const trial = this.trial(operation, client, auth);
    if (trial.buildId !== buildId)
      throw new UpdateTransitionFailure("UPDATE_CONFLICT");
    return this.state.change(this.state.snapshot().revision, (state) => {
      if (state.trial?.operationId !== operation)
        throw new UpdateTransitionFailure("UPDATE_CONFLICT");
      state.rejected = [...state.rejected, { buildId, code }].slice(-100);
      state.trial = null;
    });
  }
  async reapInterrupted() {
    const state = this.state.snapshot();
    if (!state.trial) return state;
    const buildId = state.trial.buildId;
    return this.state.change(state.revision, (next) => {
      next.rejected = [
        ...next.rejected,
        { buildId, code: "UI_TRIAL_INTERRUPTED" as const },
      ].slice(-100);
      next.trial = null;
    });
  }
}
