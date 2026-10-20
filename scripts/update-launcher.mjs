// Retained pre-import launcher. Only Node built-ins run before inventory proof.
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open, lstat, readdir, mkdir, rename } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const root = dirname(fileURLToPath(import.meta.url));
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const canonical = (value) => {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object")
    return (
      "{" +
      Object.keys(value)
        .sort()
        .map((key) => JSON.stringify(key) + ":" + canonical(value[key]))
        .join(",") +
      "}"
    );
  return JSON.stringify(value);
};
const failure = (code) => {
  throw Object.assign(new Error(code), { code });
};
async function regular(path, max = 64 * 1024 * 1024) {
  const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await fd.stat();
    if (!stat.isFile() || stat.size > max)
      failure("HOST_START_INVENTORY_FAILED");
    const bytes = await fd.readFile();
    if (bytes.length !== stat.size) failure("HOST_START_INVENTORY_FAILED");
    return { bytes, executable: !!(stat.mode & 0o111) };
  } finally {
    await fd.close();
  }
}
let uiContract = 1;
async function verify() {
  let manifest;
  try {
    manifest = JSON.parse(
      (await regular(join(root, "manifest.json"), 4 * 1024 * 1024)).bytes,
    );
  } catch {
    failure("HOST_START_MANIFEST_FAILED");
  }
  const id = manifest.identity;
  if (
    !id ||
    id.schema !== 1 ||
    id.kind !== "host" ||
    !/^[a-f0-9]{64}$/.test(manifest.buildId) ||
    hash(canonical(id)) !== manifest.buildId ||
    !Array.isArray(id.files) ||
    !id.node ||
    !id.compatibility ||
    !/^[a-f0-9]{64}$/.test(id.adapterId) ||
    id.files.length > 10_000
  )
    failure("HOST_START_MANIFEST_FAILED");
  if (
    id.node.version !== process.versions.node ||
    id.node.abi !== process.versions.modules ||
    id.node.platform !== process.platform ||
    id.node.arch !== process.arch
  )
    failure("HOST_START_NODE_FAILED");
  if (
    id.storageSchema !== 1 ||
    id.compatibility.protocol !== 1 ||
    ![1, 2].includes(id.compatibility.hostMin) ||
    id.compatibility.hostMax !== id.compatibility.hostMin
  )
    failure("HOST_START_CONTRACT_FAILED");
  const files = new Map();
  let total = 0;
  for (const file of id.files) {
    if (
      typeof file.path !== "string" ||
      /[\\\u0000:]/.test(file.path) ||
      file.path
        .split("/")
        .some((part) => !part || part === "." || part === "..") ||
      files.has(file.path) ||
      !/^[a-f0-9]{64}$/.test(file.sha256) ||
      !Number.isSafeInteger(file.bytes) ||
      file.bytes < 0 ||
      file.bytes > 64 * 1024 * 1024
    )
      failure("HOST_START_MANIFEST_FAILED");
    files.set(file.path, file);
    total += file.bytes;
  }
  if (
    total > 512 * 1024 * 1024 ||
    !files.has("launch.mjs") ||
    !files.has("dist/apps/host/src/host.js")
  )
    failure("HOST_START_MANIFEST_FAILED");
  async function walk(directory, prefix = "") {
    if (!(await lstat(directory)).isDirectory())
      failure("HOST_START_INVENTORY_FAILED");
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = prefix + entry.name;
      if (entry.isDirectory())
        await walk(join(directory, entry.name), path + "/");
      else {
        if (!entry.isFile()) failure("HOST_START_INVENTORY_FAILED");
        if (!prefix && ["manifest.json", "ready.json"].includes(path)) continue;
        const expected = files.get(path);
        if (!expected) failure("HOST_START_INVENTORY_FAILED");
        const actual = await regular(join(directory, entry.name));
        if (
          actual.bytes.length !== expected.bytes ||
          hash(actual.bytes) !== expected.sha256 ||
          actual.executable !== expected.executable
        )
          failure("HOST_START_INVENTORY_FAILED");
        files.delete(path);
      }
    }
  }
  await walk(root);
  if (files.size) failure("HOST_START_INVENTORY_FAILED");
  uiContract = id.compatibility.hostMin;
  return Object.freeze({ buildId: manifest.buildId, adapterId: id.adapterId });
}
let launchStage = "inventory";
async function status(value) {
  if (value.stage !== "failed") launchStage = value.stage;
  if (!process.env.SURI_DATA_DIR) return;
  const directory = join(resolve(process.env.SURI_DATA_DIR), "run");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, "update-launch.json");
  const temp = path + "." + randomUUID();
  const fd = await open(temp, "wx", 0o600);
  try {
    await fd.writeFile(JSON.stringify({ ...value, pid: process.pid }));
    await fd.sync();
  } finally {
    await fd.close();
  }
  await rename(temp, path);
}
try {
  await status({ stage: "inventory", code: "PENDING" });
  const identity = await verify();
  if (process.argv[2] === "--check") {
    await status({
      stage: "preflight",
      code: "VERIFIED",
      targetId: identity.buildId,
    });
    console.log(JSON.stringify(identity));
  } else if (
    process.argv[2] === "restart-worker" &&
    uiContract === 2 &&
    process.env.SURI_DATA_DIR &&
    /^[a-f0-9-]{36}$/i.test(process.env.SURI_RESTART_OPERATION ?? "")
  ) {
    await status({
      stage: "worker-import",
      code: "PENDING",
      operationId: process.env.SURI_RESTART_OPERATION,
      targetId: identity.buildId,
    });
    await (await import("./restart-worker.mjs")).runRestart(identity);
  } else {
    if (
      process.argv[2] !== "serve" ||
      !process.env.SURI_DATA_DIR ||
      !process.env.SURI_ASSETS_DIR
    )
      failure("HOST_START_ARGUMENTS_FAILED");
    const port = Number(process.env.SURI_PORT ?? 0);
    if (!Number.isInteger(port) || port < 0 || port > 65535)
      failure("HOST_START_ARGUMENTS_FAILED");
    await status({
      stage: "module-import",
      code: "PENDING",
      targetId: identity.buildId,
    });
    const { startHost } = await import("./dist/apps/host/src/host.js");
    await status({
      stage: "host-start",
      code: "PENDING",
      targetId: identity.buildId,
    });
    await startHost({
      root: resolve(process.env.SURI_DATA_DIR),
      assets: resolve(process.env.SURI_ASSETS_DIR),
      helper: join(root, "dist/native/suri-helper"),
      port,
      launchIdentity: identity,
      modernUpdates: uiContract === 2,
      simulated: process.env.SURI_SIMULATED === "1",
      validation: process.env.SURI_VALIDATE === "1",
    });
    await status({
      stage: "listening",
      code: "VERIFIED",
      targetId: identity.buildId,
    });
  }
} catch (error) {
  const codes = [
    "HOST_START_MANIFEST_FAILED",
    "HOST_START_INVENTORY_FAILED",
    "HOST_START_NODE_FAILED",
    "HOST_START_CONTRACT_FAILED",
    "HOST_START_ARGUMENTS_FAILED",
    "HOST_ADDRESS_CONFLICT",
    "HOST_LOCKED",
    "NODE_ABI_MISMATCH",
    "STORAGE_UNAVAILABLE",
    "RESTART_STATE_CORRUPT",
    "UPDATE_STATE_CORRUPT",
    "CANDIDATE_INTEGRITY",
    "CONTROL_PATH_TOO_LONG",
    "CONTROL_BIND_FAILED",
    "LISTENER_BIND_FAILED",
    "STORAGE_OPEN_FAILED",
    "HOST_LOCK_UNAVAILABLE",
  ];
  const boundedCode = error.code ?? error.detail?.code;
  const code = codes.includes(boundedCode)
    ? boundedCode
    : ["ERR_MODULE_NOT_FOUND", "MODULE_NOT_FOUND"].includes(error.code)
      ? "HOST_MODULE_MISSING"
      : error.code === "ERR_DLOPEN_FAILED"
        ? "HOST_NATIVE_MODULE_FAILED"
        : error instanceof SyntaxError
          ? "HOST_MODULE_SYNTAX_FAILED"
          : launchStage === "module-import"
            ? "HOST_MODULE_EVALUATION_FAILED"
            : launchStage === "host-start"
              ? "HOST_INITIALIZATION_FAILED"
              : "HOST_LAUNCH_BOUNDARY_FAILED";
  const frame = String(error.stack ?? "").match(
    /\/(host|pi-adapter|protocol)\/src\/([a-z-]+)\.js:(\d+)/,
  );
  const diagnostic = {
    errorType: ["Error", "TypeError", "SyntaxError", "ZodError"].includes(
      error.name,
    )
      ? error.name
      : "OtherError",
    component: frame ? frame[1] + "/" + frame[2] : "launcher",
    line: frame ? Number(frame[3]) : null,
  };
  // Best effort: the original failure is reported below even if the status file cannot be written.
  await status({
    stage: "failed",
    failedStage: launchStage,
    code,
    diagnostic,
  }).catch(() => {});
  console.error(JSON.stringify({ code }));
  process.exitCode = 1;
}
