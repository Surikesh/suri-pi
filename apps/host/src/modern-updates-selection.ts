import { join } from "node:path";
import { UiManifestSchema } from "../../../packages/protocol/src/updates.js";
import { UpdateTransitionFailure } from "./update-coordinator.js";
import { validatePrivateArtifact } from "./update-artifacts.js";
import type { UpdateCheckpoints } from "./update-checkpoint.js";
import type { UpdateStateStore } from "./update-state.js";
import type { Window } from "./modern-updates-windows.js";

type SelectionDeps = {
  root: string;
  instanceId: string;
  state: UpdateStateStore;
  checkpoints: UpdateCheckpoints;
  client: (id: string, auth: string) => Window;
};

export async function selection(deps: SelectionDeps, id: string, auth: string) {
  const client = deps.client(id, auth);
  const state = deps.state.snapshot();
  const trial =
    state.trial?.clientInstanceId === id &&
    state.trial.authClientId === auth &&
    state.trial.phase === "navigating"
      ? state.trial
      : null;
  const buildId =
    trial?.buildId ??
    (client.mode === "pinned" ? client.target : state.activeUiId) ??
    state.packagedFallbackUiId;
  if (!buildId) throw new UpdateTransitionFailure("CANDIDATE_INTEGRITY");
  const manifest = UiManifestSchema.parse(
    await validatePrivateArtifact(
      join(deps.root, "ui-builds", buildId),
      "ui",
      buildId,
    ),
  );
  if (
    manifest.identity.compatibility.hostMin > 2 ||
    manifest.identity.compatibility.hostMax < 2 ||
    (client.surface === "native" &&
      manifest.identity.compatibility.shellMin > client.shellContract)
  )
    throw new UpdateTransitionFailure("CONTRACT_INCOMPATIBLE");
  const checkpoint = await deps.checkpoints.read(id, auth);
  return {
    buildId,
    entry: manifest.identity.entry,
    styles: manifest.identity.files
      .filter((f) => /(?:^|\/)index-[^/]+\.css$/.test(f.path))
      .map((f) => f.path),
    operationId: trial?.operationId ?? null,
    checkpointRevision: trial?.checkpointRevision ?? checkpoint?.revision ?? 0,
    hostInstanceId: deps.instanceId,
    checkpoint: checkpoint?.checkpoint ?? null,
  };
}
