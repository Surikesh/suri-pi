import type { UpdateStateStore } from "./update-state.js";
import type { RestartCoordinator } from "./restart-coordinator.js";
import type { ModernWindows } from "./modern-updates-windows.js";
import type { DiscoveredPair } from "./modern-updates-reconcile.js";

type SnapshotDeps = {
  state: UpdateStateStore;
  identity?: { buildId: string; adapterId: string };
  instanceId: string;
  epoch: string;
  available: () => DiscoveredPair;
  revision: () => number;
  browserOpen: ModernWindows["browserOpen"];
  restart: () => ReturnType<RestartCoordinator["snapshot"]> | null;
  clients: ModernWindows["clients"];
};

export function buildSnapshot(deps: SnapshotDeps) {
  const state = deps.state.snapshot();
  const available = deps.available();
  const availableUiId =
    available.ui.state === "verified" ? available.ui.buildId : null;
  const quarantined = availableUiId
    ? state.rejected.find((item) => item.buildId === availableUiId)
    : undefined;
  return {
    schema: 1,
    capability: "updates-v1",
    activationSupported: true,
    revision: state.revision,
    observationRevision: deps.revision(),
    profileId: state.profileId,
    channel: state.channel,
    associationRequired: !state.association,
    runningHost: {
      buildId: deps.identity?.buildId ?? null,
      adapterId: deps.identity?.adapterId ?? null,
      instanceId: deps.instanceId,
      epoch: deps.epoch,
      provenance: deps.identity ? "verified-launch" : "legacy-unverified",
      uiContract: 2,
    },
    browserOpen: deps.browserOpen(),
    restart: deps.restart(),
    available: {
      ...available,
      ui: quarantined
        ? {
            state: "rejected",
            buildId: quarantined.buildId,
            code: quarantined.code,
          }
        : available.ui,
    },
    ui: {
      activeId: state.activeUiId,
      previousKnownGoodId: state.previousKnownGoodUiId,
      fallbackId: state.packagedFallbackUiId,
      candidate: state.candidate,
      trial: state.trial
        ? {
            operationId: state.trial.operationId,
            buildId: state.trial.buildId,
            phase: state.trial.phase,
          }
        : null,
    },
    rejected: state.rejected,
    pendingHostId: state.pendingHostId,
    clients: deps.clients(),
  };
}
