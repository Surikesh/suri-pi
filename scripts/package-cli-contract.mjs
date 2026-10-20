const startupStages = new Set([
  "platform",
  "node",
  "helper",
  "sqlite",
  "pty",
  "assets",
  "control",
  "lock",
  "storage",
  "listener",
  "child",
  "readiness",
]);

function validFailure(value) {
  return (
    value?.ok === false &&
    startupStages.has(value.stage) &&
    typeof value.code === "string" &&
    /^[A-Z][A-Z0-9_]*$/.test(value.code) &&
    typeof value.retryable === "boolean" &&
    typeof value.action === "string" &&
    value.action.length > 0
  );
}

export function parseDoctorProcess(result) {
  if (result.signal !== null)
    throw new Error("Doctor did not report a clean, unsignalled exit.");
  if (!Number.isInteger(result.status) || ![0, 1].includes(result.status))
    throw new Error("Doctor did not return the exact 0/1 exit contract.");
  const stdout = String(result.stdout ?? "").trim();
  const stderr = String(result.stderr ?? "").trim();
  let value;
  if (stdout) {
    if (stderr)
      throw new Error("Doctor wrote structured output to both streams.");
    try {
      value = JSON.parse(stdout);
    } catch {
      throw new Error("Doctor stdout was not one JSON envelope.");
    }
    if (!value?.preflight || typeof value.preflight.ok !== "boolean")
      throw new Error("Doctor stdout did not contain a preflight envelope.");
    if (value.preflight.ok === true) {
      if (
        result.status !== 0 ||
        typeof value.preflight.platform !== "string" ||
        typeof value.preflight.architecture !== "string" ||
        typeof value.preflight.node !== "string"
      )
        throw new Error("Doctor success envelope was incomplete.");
    } else if (result.status !== 1 || !validFailure(value.preflight)) {
      throw new Error("Doctor failure preflight envelope was incomplete.");
    }
    return { kind: "doctor", value };
  }
  if (!stderr) throw new Error("Doctor produced no structured output.");
  try {
    value = JSON.parse(stderr);
  } catch {
    throw new Error("Doctor stderr was not one JSON failure envelope.");
  }
  if (result.status !== 1 || !validFailure(value))
    throw new Error("Doctor stderr did not contain a direct failure envelope.");
  return { kind: "failure", value };
}
