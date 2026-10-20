import { randomUUID } from "node:crypto";
import type { Socket } from "node:net";
import { SuriError } from "../../../packages/protocol/src/index.js";
import { hostIdentity } from "./host-contract.js";
import type { ModernUpdates } from "./modern-updates.js";
import type { Grants } from "./host-grants.js";
import type { Transport } from "./host-transport.js";
import type { claimLegacyMigration } from "./legacy-migration.js";
import type { Storage } from "./storage.js";
import type { UpdateStatus } from "./update-status.js";
import type { createRestartLifecycle } from "./restart-lifecycle.js";

type LaunchIdentity = { buildId: string; adapterId: string } | undefined;

/** Narrow capabilities of the private control socket (reads are lazy getters). */
type ControlCaps = {
  closing: () => boolean;
  setClosing: (value: boolean) => void;
  origin: () => string;
  shutdownStage: () => string;
  modernUpdates: () => ModernUpdates | undefined;
  launchIdentity: LaunchIdentity;
  instanceId: string;
  childCount: () => number;
  activeWork: () => number;
  protectedWork: () => { count: number; blockers: unknown[] };
  unresolvedCompletions: () => number;
  token: () => string;
  transport: Transport;
  grants: Grants;
};

export type RestartControlCaps = ControlCaps & {
  options: {
    root: string;
    helper: string;
    simulated?: boolean;
    migrationClaim?: (
      root: string,
      supplied: Parameters<typeof claimLegacyMigration>[1],
      helper: string,
    ) => Promise<unknown>;
  };
  store: Storage;
  updateStatus: UpdateStatus;
  lifecycle: () =>
    Awaited<ReturnType<typeof createRestartLifecycle>> | undefined;
  idle: (sessionId: string) => void;
  close: () => Promise<void>;
  beginUpdateControl: () => void;
  endUpdateControl: () => void;
  setUiCheckout: (path: string) => void;
};

type BootstrapRequest = { clientId?: unknown };
type LegacyAdmitRequest = {
  schema?: unknown;
  state?: unknown;
  expectedInstanceId?: unknown;
  expectedPid?: unknown;
  profileId?: unknown;
  origin?: unknown;
  sourceBuildId?: unknown;
  sourceProvenance?: unknown;
  expiresAt: number;
  operationId?: string;
  targetBuildId?: string;
  uiBuildId?: string;
};
type HandoffRequest = {
  instanceId?: unknown;
  targetBuildId?: unknown;
  operationId?: unknown;
  workerPid: number;
};
type GrantRequest = { path: string; kind: string };
type RuntimeValidationRequest = {
  provider: string;
  model: string;
  agentDir: string;
};

/** Synchronous control-socket operations; callers keep the awaiting frame. */
export function createHostControl(caps: ControlCaps) {
  return {
    bootstrap(socket: Socket, p: BootstrapRequest) {
      if (caps.closing()) {
        socket.end('{"error":"HOST_STOPPING"}\n');
        return;
      }
      const nonce = caps.token();
      caps.transport.addNonce(nonce, {
        expires: Date.now() + 60000,
        clientId:
          typeof p.clientId === "string" && /^[a-f0-9-]{36}$/i.test(p.clientId)
            ? p.clientId
            : undefined,
      });
      socket.end(JSON.stringify({ origin: caps.origin(), nonce }) + "\n");
    },
    legacyAdmitGuard(
      p: LegacyAdmitRequest,
      status: Awaited<ReturnType<UpdateStatus["snapshot"]>>,
    ) {
      if (
        caps.closing() ||
        p.schema !== 1 ||
        p.state !== "admission-requested" ||
        p.expectedInstanceId !== caps.instanceId ||
        p.expectedPid !== process.pid ||
        p.profileId !== status.profileId ||
        p.origin !== caps.origin() ||
        p.sourceBuildId !== null ||
        p.sourceProvenance !== status.runningHost.provenance ||
        p.expiresAt <= Date.now() ||
        p.expiresAt > Date.now() + 120_000 ||
        !/^[a-f0-9-]{36}$/i.test(p.operationId ?? "") ||
        !/^[a-f0-9]{64}$/.test(p.targetBuildId ?? "") ||
        !/^[a-f0-9]{64}$/.test(p.uiBuildId ?? "")
      )
        throw new SuriError(
          "HOST_IDENTITY_CHANGED",
          "Legacy migration identity changed before admission.",
        );
    },
    handoffStatusGuard(p: HandoffRequest) {
      if (
        p.instanceId !== caps.instanceId ||
        p.targetBuildId !== caps.launchIdentity?.buildId ||
        typeof p.operationId !== "string"
      )
        throw new SuriError(
          "HANDOFF_IDENTITY_CHANGED",
          "Replacement identity does not match the handoff target.",
        );
    },
    handoffRevokeGuard(p: HandoffRequest) {
      if (
        p.instanceId !== caps.instanceId ||
        p.targetBuildId !== caps.launchIdentity?.buildId ||
        typeof p.operationId !== "string"
      )
        throw new SuriError(
          "HANDOFF_IDENTITY_CHANGED",
          "Replacement identity does not match the handoff target.",
        );
    },
    handoffCommitGuard(p: HandoffRequest) {
      if (
        p.instanceId !== caps.instanceId ||
        p.targetBuildId !== caps.launchIdentity?.buildId ||
        typeof p.operationId !== "string" ||
        !Number.isSafeInteger(p.workerPid) ||
        p.workerPid <= 0
      )
        throw new SuriError(
          "HANDOFF_IDENTITY_CHANGED",
          "Replacement identity does not match the handoff target.",
        );
      const targetIdentity = caps.launchIdentity;
      const uiBuildId = process.env.SURI_UI_BUILD_ID;
      if (!targetIdentity)
        throw new SuriError(
          "HANDOFF_IDENTITY_CHANGED",
          "Host identity is unavailable.",
        );
      if (!uiBuildId || !/^[a-f0-9]{64}$/.test(uiBuildId))
        throw new SuriError(
          "HANDOFF_IDENTITY_CHANGED",
          "UI identity is unavailable.",
        );
      return { targetIdentity, uiBuildId };
    },
    health(socket: Socket) {
      // Stopping health stays zero-work unless a completion failure is unresolved.
      const quiet = caps.closing() && caps.unresolvedCompletions() === 0;
      socket.end(
        JSON.stringify({
          ...hostIdentity,
          uiContract: caps.modernUpdates() ? 2 : 1,
          capabilities: [
            ...hostIdentity.capabilities,
            ...(caps.modernUpdates() ? ["updates-v1"] : []),
          ],
          hostBuildId: caps.launchIdentity?.buildId ?? null,
          uiBuildId:
            caps.modernUpdates() &&
            /^[a-f0-9]{64}$/.test(process.env.SURI_UI_BUILD_ID ?? "")
              ? process.env.SURI_UI_BUILD_ID
              : null,
          adapterBuildId: caps.launchIdentity?.adapterId ?? null,
          hostPresent: true,
          pid: process.pid,
          instanceId: caps.instanceId,
          lifecycle: caps.closing() ? "stopping" : "running",
          shutdownStage: caps.shutdownStage(),
          sessions: caps.childCount(),
          activeWork: quiet ? 0 : caps.activeWork(),
          work: quiet ? { count: 0, blockers: [] } : caps.protectedWork(),
        }) + "\n",
      );
    },
    grant(socket: Socket, p: GrantRequest) {
      const id = randomUUID();
      caps.grants.mint(id, {
        path: p.path,
        kind: p.kind,
        expires: Date.now() + 60000,
      });
      socket.end(JSON.stringify({ grantId: id }) + "\n");
    },
    runtimeValidationGrant(socket: Socket, p: RuntimeValidationRequest) {
      const id = randomUUID();
      caps.grants.mint(id, {
        kind: "runtime-validation",
        profile: {
          provider: p.provider,
          model: p.model,
          agentDir: p.agentDir,
        },
        expires: Date.now() + 60_000,
      });
      socket.end(JSON.stringify({ grantId: id }) + "\n");
    },
  };
}
export type HostControl = ReturnType<typeof createHostControl>;
