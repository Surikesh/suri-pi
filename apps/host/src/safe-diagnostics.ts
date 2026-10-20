import { randomUUID } from "node:crypto";

type DiagnosticStage =
  "command" | "async-job" | "startup" | "shutdown" | "runtime";

/**
 * Emit only allowlisted diagnostic fields. Never pass an Error, path, payload,
 * environment value, process output, or upstream text to this boundary.
 */
export function reportDiagnostic(stage: DiagnosticStage, code: string) {
  const correlationId = randomUUID();
  console.error(
    JSON.stringify({
      product: "suri-pi",
      stage,
      code,
      correlationId,
    }),
  );
  return correlationId;
}
