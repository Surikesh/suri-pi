import { z } from "zod";
import type { UpdateStateStore } from "./update-state.js";
import type { UpdateCoordinator } from "./update-coordinator.js";
import type {
  DiscoveredArtifact,
  UpdateDiscovery,
} from "./update-discovery.js";

export type DiscoveredPair = {
  ui: DiscoveredArtifact;
  host: DiscoveredArtifact;
};
type ReconcileDeps = {
  state: UpdateStateStore;
  discovery: UpdateDiscovery;
  coordinator: UpdateCoordinator;
  identity?: { buildId: string; adapterId: string };
  available: () => DiscoveredPair;
  commitAvailable: (next: DiscoveredPair) => void;
};

export async function doReconcile(deps: ReconcileDeps) {
  const state = deps.state.snapshot();
  if (!state.association || state.channel !== "development") return;
  const next = await deps.discovery.reconcile(state.association);
  if (
    next.ui.state === "verified" &&
    (next.ui.compatibility.hostMin > 2 || next.ui.compatibility.hostMax < 2)
  )
    next.ui = {
      state: "rejected",
      buildId: next.ui.buildId,
      code: "CONTRACT_INCOMPATIBLE",
    };
  if (
    next.host.state === "verified" &&
    (next.host.compatibility.hostMin !== 2 ||
      next.host.compatibility.hostMax !== 2 ||
      next.host.compatibility.shellMin > 2 ||
      next.host.node?.version !== process.versions.node ||
      next.host.node?.abi !== process.versions.modules ||
      next.host.node?.platform !== process.platform ||
      next.host.node?.arch !== process.arch)
  )
    next.host = {
      state: "rejected",
      buildId: next.host.buildId,
      code: "NATIVE_REBUILD_REQUIRED",
    };
  if (JSON.stringify(next) !== JSON.stringify(deps.available())) {
    deps.commitAvailable(next);
  }
  const availableUiId = next.ui.state === "verified" ? next.ui.buildId : null;
  const candidate =
    next.ui.state === "verified"
      ? state.rejected.some((item) => item.buildId === availableUiId)
        ? null
        : { buildId: next.ui.buildId, generation: next.ui.generation }
      : null;
  const pendingHostId =
    next.host.state === "verified"
      ? next.host.buildId !== deps.identity?.buildId
        ? next.host.buildId
        : null
      : null;
  const rejected = [next.ui, next.host].filter(
    (item) => item.state === "rejected",
  );
  if (
    JSON.stringify(candidate) !== JSON.stringify(state.candidate) ||
    pendingHostId !== state.pendingHostId ||
    rejected.some(
      (item) =>
        !state.rejected.some(
          (r) => r.buildId === item.buildId && r.code === item.code,
        ),
    )
  ) {
    await deps.state.change(deps.state.snapshot().revision, (draft) => {
      draft.candidate = candidate;
      draft.pendingHostId = pendingHostId;
      for (const item of rejected)
        if (
          !draft.rejected.some(
            (r) => r.buildId === item.buildId && r.code === item.code,
          )
        )
          draft.rejected.push({
            buildId: item.buildId,
            code: z
              .enum([
                "CANDIDATE_INTEGRITY",
                "CHECKOUT_CHANGED",
                "CONTRACT_INCOMPATIBLE",
                "NATIVE_REBUILD_REQUIRED",
                "STORAGE_UNAVAILABLE",
                "CANDIDATE_LIMIT",
              ])
              .parse(item.code),
          });
      draft.rejected = draft.rejected.slice(-100);
    });
  }
  const trial = deps.state.snapshot().trial;
  if (trial && trial.deadline < Date.now())
    await deps.coordinator.reapInterrupted();
}
