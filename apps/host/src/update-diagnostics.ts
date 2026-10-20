import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";

const fields: Record<string, RegExp> = {
  stage: /^[a-z][a-z-]{0,59}$/,
  failedStage: /^[a-z][a-z-]{0,59}$/,
  errorType: /^(Error|TypeError|SyntaxError|ZodError|OtherError)$/,
  oldHostState: /^(unknown|running|stopping|stopped)$/,
  action: /^(none|wait-for-idle|inspect-diagnostics)$/,
  phase: /^[a-z][a-z-]{0,59}$/,
  code: /^[A-Z][A-Z_]{0,79}$/,
  component: /^(launcher|host|pi-adapter|protocol)(\/[a-z][a-z-]{0,59})?$/,
  operationId: /^[a-f0-9-]{36}$/,
  fromInstanceId: /^[a-f0-9-]{36}$/,
  targetId: /^[a-f0-9]{64}$/,
  targetBuildId: /^[a-f0-9]{64}$/,
  hostBuildId: /^[a-f0-9]{64}$/,
  instanceId: /^[a-f0-9-]{36}$/,
  at: /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/,
  barrierId: /^[a-f0-9-]{36}$/,
};
async function observation(
  path: string,
): Promise<Record<string, string | number | boolean>> {
  let fd;
  try {
    fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await fd.stat();
    if (!stat.isFile()) return { status: "UNSAFE_FILE" };
    if (stat.size > 65536) return { status: "OVERSIZE" };
    const bytes = Buffer.alloc(65537);
    const { bytesRead } = await fd.read(bytes, 0, bytes.length, 0);
    if (bytesRead > 65536) return { status: "OVERSIZE" };
    const source = JSON.parse(bytes.subarray(0, bytesRead).toString("utf8"));
    if (!source || typeof source !== "object" || Array.isArray(source))
      return { status: "INVALID" };
    const result: Record<string, string | number | boolean> = {
      status: "OBSERVED",
    };
    for (const [key, pattern] of Object.entries(fields))
      if (typeof source[key] === "string" && pattern.test(source[key]))
        result[key] = source[key];
    for (const key of ["pid", "workerPid", "line", "expiresAt"])
      if (Number.isSafeInteger(source[key]) && source[key] >= 0)
        result[key] = source[key];
    const detail = source.diagnostic;
    if (detail && typeof detail === "object" && !Array.isArray(detail)) {
      for (const key of ["component", "errorType"])
        if (typeof detail[key] === "string" && fields[key].test(detail[key]))
          result[key] = detail[key];
      if (Number.isSafeInteger(detail.line) && detail.line >= 0)
        result.line = detail.line;
    }
    if (typeof source.retryable === "boolean")
      result.retryable = source.retryable;
    return result;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return {
      status:
        code === "ENOENT"
          ? "ABSENT"
          : code === "ELOOP"
            ? "UNSAFE_FILE"
            : error instanceof SyntaxError
              ? "INVALID"
              : "UNREADABLE",
    };
  } finally {
    await fd?.close();
  }
}
/** Available without a connection, lease, bootstrap or running host. Never dumps raw records. */
export async function updateDiagnostics(root: string) {
  const [launch, approval] = await Promise.all([
    observation(join(root, "run/update-launch.json")),
    observation(join(root, "updates/restart.json")),
  ]);
  const operationId = "operationId" in approval ? approval.operationId : null;
  const restart = await observation(
    typeof operationId === "string"
      ? join(root, "run", "restart-" + operationId + ".json")
      : join(root, "run/restart-execution.json"),
  );
  return { v: 1, source: "persisted-not-live", launch, restart, approval };
}
