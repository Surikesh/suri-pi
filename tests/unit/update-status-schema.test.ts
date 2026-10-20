import { describe, expect, it } from "vitest";
import { UpdateStatusSchema } from "../../apps/host/src/update-status.js";

const id = "a".repeat(64);
const status = {
  schema: 1,
  capability: "updates-status-v1",
  revision: 2,
  profileId: "ab015a58-082d-4639-a0e9-553fe3efd6ca",
  channel: "development",
  runningHost: {
    buildId: null,
    adapterId: null,
    instanceId: "70e041ff-2cc8-4f98-8737-b9904d76e49e",
    epoch: "ab015a58-082d-4639-a0e9-553fe3efd6ca",
    uiContract: 1,
    provenance: "legacy-unverified",
  },
  ui: { activeId: null, previousKnownGoodId: null, fallbackId: null },
  activationSupported: false,
  associationRequired: false,
  available: {
    ui: { state: "none" },
    host: {
      state: "verified",
      buildId: id,
      generation: 132,
      compatibility: {
        protocol: 1,
        hostMin: 2,
        hostMax: 2,
        checkpoint: 1,
        shellMin: 2,
      },
      adapterId: id,
      node: {
        version: "24.15.0",
        abi: "137",
        platform: "darwin",
        arch: "arm64",
      },
    },
  },
} as const;

describe("legacy update status at the discovered host boundary", () => {
  it("accepts the verified host's Node identity instead of masking it as UPDATE_RECONCILE_FAILED", () => {
    expect(UpdateStatusSchema.parse(status).available.host).toEqual(
      status.available.host,
    );
  });
  it("still rejects unrecognized host fields", () => {
    expect(
      UpdateStatusSchema.safeParse({
        ...status,
        available: {
          ...status.available,
          host: { ...status.available.host, unexpected: "unsafe" },
        },
      }).success,
    ).toBe(false);
  });
});
