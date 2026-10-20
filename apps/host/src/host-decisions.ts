import { SuriError, type Data } from "../../../packages/protocol/src/index.js";
import type { ModernUpdates } from "./modern-updates.js";

/**
 * Synchronous dispatch decisions. The dispatcher still owns the gate branch,
 * session validation, the draftOwner assignment, the awaited modern-update
 * command, receipt publication, reservation and the catch.
 */

const observationalCommands = ["host.get", "catalog.get", "host.shutdown"];

/** Commands still admitted while the host is closing. */
export function admittedWhileClosing(type: string) {
  return observationalCommands.includes(type);
}

export function hostStopping() {
  return new SuriError(
    "HOST_STOPPING",
    "The host is stopping and cannot accept new work.",
    true,
  );
}

/** Commands that bypass pending-command accounting. */
export function createPureCommands() {
  return new Set(["host.get", "catalog.get", "updates.get", "updates.client"]);
}

/** Operation/instance targeting required by ui.activate and ui.rollback (same short-circuit order). */
export function hasUpdateTarget(type: string, p: Data) {
  return (
    (type !== "ui.activate" || p.operationId) &&
    (type !== "ui.rollback" || p.clientInstanceId)
  );
}

export function updateRejected(error: unknown) {
  const code =
    error instanceof Error && "code" in error && typeof error.code === "string"
      ? error.code
      : "VALIDATION";
  return new SuriError(
    code,
    `Update transition rejected (${code}). Your current interface and draft are retained.`,
  );
}

export function wantsWindowDraftOwner(type: string) {
  return ["draft.get", "draft.save", "run.cancel", "queue.clear"].includes(
    type,
  );
}

export function windowDraftOwner(
  modernUpdates: Pick<ModernUpdates, "draftOwner">,
  p: Data,
  clientId: string,
) {
  try {
    return modernUpdates.draftOwner(p.clientInstanceId, clientId);
  } catch {
    throw new SuriError(
      "UNAUTHORIZED",
      "A live window-owned draft lease is required.",
    );
  }
}

export function checkShutdownIdentity(p: Data, instanceId: string) {
  if (p.expectedInstanceId !== undefined && p.expectedInstanceId !== instanceId)
    throw new SuriError(
      "HOST_IDENTITY_CHANGED",
      "The host instance changed before shutdown admission.",
    );
}

export function checkShutdownIdle(
  closing: boolean,
  activeWork: () => number,
  pendingIngress: number,
  pendingCommands: number,
) {
  if (
    !closing &&
    activeWork() - Math.min(pendingIngress, 1) - Math.min(pendingCommands, 1) >
      0
  )
    throw new SuriError(
      "HOST_BUSY",
      "Finish or stop active work before shutting down.",
      true,
    );
}
