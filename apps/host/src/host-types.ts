import type { claimLegacyMigration } from "./legacy-migration.js";
import type { RuntimeValidator } from "./runtime-validation.js";
import type { Data } from "../../../packages/protocol/src/index.js";
import type { QueueBootPermit } from "./host-queue-workers.js";
import type { createSessionStart } from "./host-session-start.js";

export type HostOptions = {
  root: string;
  assets: string;
  helper: string;
  validation?: boolean;
  port?: number;
  uiCheckout?: string;
  directoryHome?: string;
  simulated?: boolean;
  runtimeValidator?: RuntimeValidator;
  /** Contract-2 surface, enabled only by the verified modern launch route. */
  modernUpdates?: boolean;
  /** Supplied only by the retained pre-import launcher after inventory verification. */
  launchIdentity?: Readonly<{ buildId: string; adapterId: string }>;
  /** Explicit compiled queue extension path; tests may supply a fixture path. */
  reviewQueueExtension?: string;
  /** Deterministic queue boot timeout seam; production uses 20 seconds. */
  reviewQueueBootTimeoutMs?: number;
  /** Deterministic admission-race seam; production always uses the persisted claim. */
  migrationClaim?: (
    root: string,
    supplied: Parameters<typeof claimLegacyMigration>[1],
    helper: string,
  ) => Promise<unknown>;
};

/** Session boot operation shared by the dispatcher and the async job factories. */
export type StartSession = ReturnType<
  typeof createSessionStart
>["startSession"];

/** Host-internal options of executeUnlocked (queue workers and reserved ids). */
export type ExecuteInternal = {
  reservedSessionId?: string;
  rejectExistingSession?: boolean;
  queueWorker?: Data;
  queueBootPermit?: QueueBootPermit;
};
