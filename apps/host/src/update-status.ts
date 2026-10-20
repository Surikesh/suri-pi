import { z } from "zod";
import { UpdateStateStore } from "./update-state.js";
import { checkoutIdentity, ImmutableArtifacts } from "./update-artifacts.js";
import {
  UpdateDiscovery,
  type DiscoveredArtifact,
} from "./update-discovery.js";
import {
  BuildIdSchema,
  CompatibilitySchema,
  HostIdentitySchema,
} from "../../../packages/protocol/src/updates.js";

const DiscoveredSchema = z.discriminatedUnion("state", [
  z.strictObject({ state: z.literal("none") }),
  z.strictObject({
    state: z.literal("rejected"),
    buildId: BuildIdSchema.nullable(),
    code: z.enum([
      "CANDIDATE_INTEGRITY",
      "CHECKOUT_CHANGED",
      "CONTRACT_INCOMPATIBLE",
      "STORAGE_UNAVAILABLE",
      "CANDIDATE_LIMIT",
    ]),
  }),
  z.strictObject({
    state: z.literal("verified"),
    buildId: BuildIdSchema,
    generation: z.number().int().positive(),
    compatibility: CompatibilitySchema,
    adapterId: BuildIdSchema.optional(),
    node: HostIdentitySchema.shape.node.optional(),
  }),
]);

export const UpdateStatusSchema = z.strictObject({
  schema: z.literal(1),
  capability: z.literal("updates-status-v1"),
  revision: z.number().int().nonnegative(),
  profileId: z.uuid(),
  channel: z.enum(["packaged", "development"]),
  runningHost: z.strictObject({
    buildId: BuildIdSchema.nullable(),
    adapterId: BuildIdSchema.nullable(),
    instanceId: z.uuid(),
    epoch: z.uuid(),
    uiContract: z.literal(1),
    provenance: z.enum(["legacy-unverified", "verified-launch"]),
  }),
  ui: z.strictObject({
    activeId: BuildIdSchema.nullable(),
    previousKnownGoodId: BuildIdSchema.nullable(),
    fallbackId: BuildIdSchema.nullable(),
  }),
  // Full transition capability is intentionally not advertised by this read-only owner.
  activationSupported: z.literal(false),
  associationRequired: z.boolean(),
  available: z.strictObject({ ui: DiscoveredSchema, host: DiscoveredSchema }),
});
export class UpdateStatus {
  private state?: Promise<UpdateStateStore>;
  private readonly discovery: UpdateDiscovery;
  constructor(
    readonly root: string,
    helper: string,
    private readonly launchIdentity?: Readonly<{
      buildId: string;
      adapterId: string;
    }>,
  ) {
    this.discovery = new UpdateDiscovery(new ImmutableArtifacts(root, helper));
  }
  private load() {
    return (this.state ??= UpdateStateStore.load(this.root));
  }
  async associate(path: string) {
    const association = await checkoutIdentity(path);
    const store = await this.load();
    await store.change(store.snapshot().revision, (state) => {
      state.association = association;
      state.channel = "development";
    });
  }
  async snapshot(instanceId: string, epoch: string) {
    const state = (await this.load()).snapshot();
    const absent: { ui: DiscoveredArtifact; host: DiscoveredArtifact } = {
      ui: { state: "none" },
      host: { state: "none" },
    };
    const available = state.association
      ? await this.discovery.reconcile(state.association)
      : absent;
    return UpdateStatusSchema.parse({
      schema: 1,
      capability: "updates-status-v1",
      revision: state.revision,
      profileId: state.profileId,
      channel: state.channel,
      runningHost: {
        buildId: this.launchIdentity?.buildId ?? null,
        adapterId: this.launchIdentity?.adapterId ?? null,
        instanceId,
        epoch,
        uiContract: 1,
        provenance: this.launchIdentity
          ? "verified-launch"
          : "legacy-unverified",
      },
      ui: {
        activeId: state.activeUiId,
        previousKnownGoodId: state.previousKnownGoodUiId,
        fallbackId: state.packagedFallbackUiId,
      },
      activationSupported: false,
      associationRequired: !state.association,
      available,
    });
  }
}
