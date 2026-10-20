import { SuriError, type Data } from "../../../packages/protocol/src/index.js";

const evidenceIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const maximumEvidenceAgeMs = 7 * 24 * 60 * 60 * 1000;
const maximumClockSkewMs = 5 * 60 * 1000;

export const runtimeAcceptanceCases = [
  "spawn",
  "stream",
  "tool-call",
  "cancel",
  "reconnect",
  "resume",
  "persistence",
] as const;

type RuntimeIdentity = {
  version: string;
  identity: string;
  executableSha256: string;
  adapterIdentity: "suri-pi-adapter/v1";
};

/**
 * Validation is intentionally capability-gated. Only the host-owned real-runtime
 * acceptance path may set trustedSource=true. Files supplied to maintenance
 * scripts, fixtures, and simulated runs are never trusted promotion evidence.
 */
export function validateRuntimeAcceptanceEvidence(
  value: unknown,
  expected: RuntimeIdentity,
  trustedSource: boolean,
) {
  if (!trustedSource)
    throw new SuriError(
      "RUNTIME_EVIDENCE_UNTRUSTED",
      "Runtime promotion requires host-owned real acceptance evidence.",
    );
  const evidence = value as Data;
  const validatedAt =
    typeof evidence?.validatedAt === "string"
      ? Date.parse(evidence.validatedAt)
      : Number.NaN;
  const caseNames =
    evidence?.cases && typeof evidence.cases === "object"
      ? Object.keys(evidence.cases).sort()
      : [];
  if (
    evidence?.schema !== "suri.runtime-acceptance.v1" ||
    evidence?.scope !== "real-pi" ||
    evidence?.producer !== "suri-host-runtime-validation/v1" ||
    evidence?.simulated !== false ||
    evidence?.passed !== true ||
    evidence?.version !== expected.version ||
    evidence?.identity !== expected.identity ||
    evidence?.executableSha256 !== expected.executableSha256 ||
    evidence?.adapterIdentity !== expected.adapterIdentity ||
    typeof evidence.evidenceId !== "string" ||
    !evidenceIdPattern.test(evidence.evidenceId) ||
    !Number.isFinite(validatedAt) ||
    new Date(validatedAt).toISOString() !== evidence.validatedAt ||
    validatedAt < Date.now() - maximumEvidenceAgeMs ||
    validatedAt > Date.now() + maximumClockSkewMs ||
    caseNames.join("\0") !== [...runtimeAcceptanceCases].sort().join("\0") ||
    !runtimeAcceptanceCases.every(
      (name) => (evidence.cases as Data)[name] === true,
    )
  )
    throw new SuriError(
      "RUNTIME_EVIDENCE_INVALID",
      "Runtime acceptance evidence is incomplete or does not match this candidate.",
    );
  return {
    evidenceId: evidence.evidenceId as string,
    validatedAt: evidence.validatedAt as string,
  };
}
