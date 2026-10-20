import { z } from "zod";
import {
  UpdateCommandPayloads,
  type UpdateCommandType,
} from "../../../packages/protocol/src/update-commands.js";
import { UpdateStateStore } from "./update-state.js";
import {
  UpdateCoordinator,
  UpdateTransitionFailure,
} from "./update-coordinator.js";
import { UpdateCheckpoints } from "./update-checkpoint.js";
import { checkoutIdentity, ImmutableArtifacts } from "./update-artifacts.js";
import {
  UpdateDiscovery,
  type DiscoveredArtifact,
} from "./update-discovery.js";
import { createModernWindows } from "./modern-updates-windows.js";
import { buildSnapshot } from "./modern-updates-snapshot.js";
import { selection } from "./modern-updates-selection.js";
import { doReconcile } from "./modern-updates-reconcile.js";
import type { RestartCoordinator } from "./restart-coordinator.js";

export class ModernUpdates {
  private readonly windowOps = createModernWindows();
  requestBrowserOpen(client: string): Promise<boolean> {
    return this.windowOps.requestBrowserOpen(client);
  }
  restart?: RestartCoordinator;
  get restartTarget() {
    const host = this.available.host;
    return host.state === "verified" && host.buildId !== this.identity?.buildId
      ? { buildId: host.buildId, generation: host.generation }
      : null;
  }
  onlineClients() {
    return this.windowOps.onlineClients();
  }
  private readonly artifacts: ImmutableArtifacts;
  private readonly discovery: UpdateDiscovery;
  readonly coordinator: UpdateCoordinator;
  private readonly checkpoints: UpdateCheckpoints;
  private available: { ui: DiscoveredArtifact; host: DiscoveredArtifact } = {
    ui: { state: "none" },
    host: { state: "none" },
  };
  private reconciling?: Promise<void>;
  private revision = 0;
  private timer?: ReturnType<typeof setInterval>;
  private constructor(
    readonly root: string,
    readonly state: UpdateStateStore,
    helper: string,
    readonly instanceId: string,
    readonly epoch: string,
    private readonly identity?: { buildId: string; adapterId: string },
  ) {
    this.artifacts = new ImmutableArtifacts(root, helper);
    this.discovery = new UpdateDiscovery(this.artifacts);
    this.coordinator = new UpdateCoordinator(root, state, instanceId);
    this.checkpoints = new UpdateCheckpoints(root);
  }
  static async create(options: {
    root: string;
    helper: string;
    assets: string;
    checkout?: string;
    instanceId: string;
    epoch: string;
    identity?: { buildId: string; adapterId: string };
  }) {
    const state = await UpdateStateStore.load(options.root);
    const owner = new ModernUpdates(
      options.root,
      state,
      options.helper,
      options.instanceId,
      options.epoch,
      options.identity,
    );
    await owner.coordinator.reapInterrupted();
    if (!state.snapshot().packagedFallbackUiId) {
      const baseline = await owner.artifacts.baseline(options.assets);
      await state.change(state.snapshot().revision, (draft) => {
        draft.packagedFallbackUiId = baseline.manifest.buildId;
        draft.activeUiId ??= baseline.manifest.buildId;
      });
    }
    // Migrate only the existing explicit owner association, never infer trust from cwd.
    if (!state.snapshot().association && options.checkout) {
      try {
        await owner.associate(options.checkout);
      } catch {
        await state.change(state.snapshot().revision, (draft) => {
          draft.rejected.push({ buildId: null, code: "CHECKOUT_CHANGED" });
        });
      }
    }
    await owner.reconcile();
    return owner;
  }
  async associate(path: string) {
    const association = await checkoutIdentity(path);
    await this.state.change(this.state.snapshot().revision, (draft) => {
      draft.association = association;
      draft.channel = "development";
    });
    await this.reconcile();
  }
  start(changed: () => void) {
    this.timer = setInterval(() => {
      const before = JSON.stringify(this.snapshot());
      // Best effort: a failed reconcile is retried on the next tick; the timer must not raise an unhandled rejection.
      void this.reconcile()
        .then(() => {
          if (before !== JSON.stringify(this.snapshot())) changed();
        })
        .catch(() => {});
    }, 2000);
    this.timer.unref();
  }
  get busy() {
    return this.reconciling ? 1 : 0;
  }
  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.windowOps.finishAllOpenRequests();
    await this.reconciling;
  }
  reconcile(): Promise<void> {
    if (this.reconciling) return this.reconciling;
    this.reconciling = this.doReconcile().finally(() => {
      this.reconciling = undefined;
    });
    return this.reconciling;
  }
  private doReconcile() {
    return doReconcile({
      state: this.state,
      discovery: this.discovery,
      coordinator: this.coordinator,
      identity: this.identity,
      available: () => this.available,
      commitAvailable: (next) => {
        this.available = next;
        this.revision++;
      },
    });
  }
  snapshot() {
    return buildSnapshot({
      state: this.state,
      identity: this.identity,
      instanceId: this.instanceId,
      epoch: this.epoch,
      available: () => this.available,
      revision: () => this.revision,
      browserOpen: () => this.windowOps.browserOpen(),
      restart: () => this.restart?.snapshot() ?? null,
      clients: () => this.windowOps.clients(),
    });
  }
  private client(id: string, auth: string) {
    return this.windowOps.client(id, auth);
  }
  draftOwner(id: string, auth: string) {
    this.client(z.uuid().parse(id), auth);
    return id;
  }
  selection(id: string, auth: string) {
    return selection(
      {
        root: this.root,
        instanceId: this.instanceId,
        state: this.state,
        checkpoints: this.checkpoints,
        client: (clientId, clientAuth) => this.client(clientId, clientAuth),
      },
      id,
      auth,
    );
  }
  async command(
    type: UpdateCommandType,
    raw: unknown,
    auth: string,
    lifecycleIdle = false,
  ): Promise<unknown> {
    const p = UpdateCommandPayloads[type].parse(raw);
    const client = p.clientInstanceId;
    if (type === "updates.client") {
      const input = UpdateCommandPayloads["updates.client"].parse(raw);
      this.windowOps.register(client, auth, input, () => {
        if (
          input.mode === "pinned" &&
          (!input.loadedUiId ||
            !this.state.snapshot().knownGood.includes(input.loadedUiId))
        )
          throw new UpdateTransitionFailure("CONTRACT_INCOMPATIBLE");
        this.coordinator.register(client, auth);
      });
      return this.snapshot();
    }
    const window = this.client(client, auth);
    if (type.startsWith("host.restart.")) {
      if (!this.restart || !this.identity)
        throw new UpdateTransitionFailure("CONTRACT_INCOMPATIBLE");
      if (type === "host.restart.approve") {
        const input = UpdateCommandPayloads[type].parse(raw);
        return this.restart.approve(
          input.targetBuildId,
          input.mode,
          input.generation,
          lifecycleIdle,
        );
      }
      if (type === "host.restart.cancel") {
        const input = UpdateCommandPayloads[type].parse(raw);
        return this.restart.cancel(input.operationId);
      }
      if (type === "host.restart.checkpoint") {
        const input = UpdateCommandPayloads[type].parse(raw);
        this.restart.binding(input.operationId, input.barrierId);
        return this.checkpoints.save(
          client,
          auth,
          input.barrierId,
          input.expectedCheckpointRevision,
          input.checkpoint,
        );
      }
      if (type === "host.restart.ack") {
        const input = UpdateCommandPayloads[type].parse(raw);
        const record = await this.checkpoints.read(client, auth);
        if (
          record?.operationId !== input.barrierId ||
          record.revision !== input.checkpointRevision
        )
          throw new UpdateTransitionFailure("UPDATE_CONFLICT");
        this.restart.acknowledge(input.operationId, client, input.barrierId);
        return this.snapshot();
      }
    }
    if (type === "ui.rendezvous") {
      const input = UpdateCommandPayloads[type].parse(raw);
      const request = this.windowOps.openRequest(input.requestId);
      if (!request || request.client !== client)
        throw new UpdateTransitionFailure("UPDATE_CONFLICT");
      const record = await this.checkpoints.save(
        client,
        auth,
        input.requestId,
        input.expectedCheckpointRevision,
        input.checkpoint,
      );
      request.finish(true);
      return { revision: record.revision };
    }
    if (type === "ui.prepare") {
      const input = UpdateCommandPayloads[type].parse(raw);
      return this.coordinator.prepare(
        input.buildId,
        input.expectedUpdateRevision,
        client,
        auth,
      );
    }
    if (type === "ui.checkpoint") {
      const input = UpdateCommandPayloads[type].parse(raw);
      return this.coordinator.checkpoint(
        input.operationId,
        client,
        auth,
        input.expectedCheckpointRevision,
        input.checkpoint,
      );
    }
    if (type === "ui.activate") {
      const input = UpdateCommandPayloads[type].parse(raw);
      await this.coordinator.activate(
        input.operationId,
        input.buildId,
        client,
        auth,
        input.expectedUpdateRevision,
        input.checkpointRevision,
      );
      return { url: "/app" };
    }
    if (type === "ui.ready") {
      const input = UpdateCommandPayloads[type].parse(raw);
      if (input.operationId)
        await this.coordinator.ready(
          input.operationId,
          input.buildId,
          client,
          auth,
          input.checkpointRevision,
          input.hostInstanceId,
          input.catalogSeq,
        );
      else {
        if (
          input.hostInstanceId !== this.instanceId ||
          (await this.selection(client, auth)).buildId !== input.buildId
        )
          throw new UpdateTransitionFailure("UPDATE_CONFLICT");
        if (!this.state.snapshot().knownGood.includes(input.buildId)) {
          try {
            await this.state.change(this.state.snapshot().revision, (draft) => {
              if (!draft.knownGood.includes(input.buildId))
                draft.knownGood.push(input.buildId);
            });
          } catch (error) {
            // Concurrent windows can acknowledge the same initial fallback. Its
            // completed receipt is idempotent, not a broken candidate or a retry.
            if (!(
              error instanceof Error &&
              "code" in error &&
              error.code === "UPDATE_CONFLICT" &&
              this.state.snapshot().knownGood.includes(input.buildId)
            ))
              throw error;
          }
        }
      }
      window.loadedUiId = input.buildId;
      if (window.mode === "pinned") window.target = input.buildId;
      return this.snapshot();
    }
    if (type === "ui.failed") {
      const input = UpdateCommandPayloads[type].parse(raw);
      if (input.operationId)
        await this.coordinator.failed(
          input.operationId,
          input.buildId,
          client,
          auth,
          input.code,
        );
      else if (this.state.snapshot().activeUiId === input.buildId) {
        await this.state.change(this.state.snapshot().revision, (draft) => {
          draft.activeUiId =
            draft.previousKnownGoodUiId ?? draft.packagedFallbackUiId;
          draft.rejected = [
            ...draft.rejected,
            { buildId: input.buildId, code: input.code },
          ].slice(-100);
        });
      }
      if (window.target === input.buildId) {
        window.mode = "follow";
        window.target = null;
      }
      return { url: "/app?fallback=1" };
    }
    if (type === "ui.follow") {
      window.mode = "follow";
      window.target = null;
      return { url: "/app" };
    }
    if (type === "ui.pin") {
      const input = UpdateCommandPayloads[type].parse(raw);
      if (!this.state.snapshot().knownGood.includes(input.buildId))
        throw new UpdateTransitionFailure("CONTRACT_INCOMPATIBLE");
      window.mode = "pinned";
      window.target = input.buildId;
      return { url: "/app" };
    }
    const input = UpdateCommandPayloads["ui.rollback"].parse(raw);
    const state = this.state.snapshot();
    const target =
      input.target === "previous"
        ? state.previousKnownGoodUiId
        : state.packagedFallbackUiId;
    if (!target) throw new UpdateTransitionFailure("CONTRACT_INCOMPATIBLE");
    return this.coordinator.prepare(
      target,
      input.expectedUpdateRevision,
      client,
      auth,
    );
  }
  readAsset(buildId: string, path: string) {
    return this.artifacts.readUiFile(buildId, path);
  }
}
