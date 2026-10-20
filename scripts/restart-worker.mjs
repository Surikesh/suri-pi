// One-shot retained lifecycle worker. Launched only through inventory-verified
// launch.mjs; no shell command, arbitrary executable, force stop, or OS open.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { connect } from "node:net";
import { readFile, open, rename } from "node:fs/promises";
import { join, resolve } from "node:path";
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const fail = (code) => {
  throw Object.assign(new Error(code), { code });
};
export async function runRestart(identity) {
  const root = resolve(process.env.SURI_DATA_DIR);
  const operationId = process.env.SURI_RESTART_OPERATION;
  if (!/^[a-f0-9-]{36}$/.test(operationId || ""))
    fail("RESTART_APPROVAL_INVALID");
  let operation,
    lease,
    stage = "approval",
    oldHostState = "unknown",
    boundInstanceId,
    bindMayHaveCommitted = false;
  const reportPath = join(root, "run", "restart-" + operationId + ".json");
  async function report(code, extra = {}) {
    const path = reportPath + "." + randomUUID();
    const file = await open(path, "wx", 0o600);
    try {
      await file.writeFile(
        JSON.stringify({
          operationId,
          workerPid: process.pid,
          at: new Date().toISOString(),
          targetBuildId: operation?.targetBuildId,
          fromInstanceId: operation?.fromInstanceId,
          stage,
          code,
          oldHostState,
          retryable: code === "HOST_BUSY",
          action:
            code === "HOST_BUSY"
              ? "wait-for-idle"
              : ["PENDING", "VERIFIED"].includes(code)
                ? "none"
                : "inspect-diagnostics",
          ...extra,
        }),
      );
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(path, reportPath);
  }
  async function control(message) {
    return new Promise((resolve, reject) => {
      const socket = connect(join(root, "run/control.sock"));
      let bytes = "";
      socket.setTimeout(2000, () =>
        socket.destroy(Object.assign(Error(), { code: "ETIMEDOUT" })),
      );
      socket.on("connect", () => socket.write(JSON.stringify(message) + "\n"));
      socket.on("data", (chunk) => {
        bytes += chunk;
        if (bytes.length > 65536) return socket.destroy(Error());
        if (bytes.includes("\n")) {
          socket.end();
          try {
            resolve(JSON.parse(bytes.split("\n")[0]));
          } catch {
            reject(Error());
          }
        }
      });
      socket.on("error", reject);
      socket.on("end", () => {
        if (!bytes.includes("\n")) reject(Error());
      });
    });
  }
  async function run(executable, args, timeout = 10000) {
    return new Promise((resolve, reject) => {
      const child = spawn(executable, args, {
        cwd: root,
        env: process.env,
        stdio: ["pipe", "pipe", "ignore"],
      });
      let output = "";
      child.stdin.end();
      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        reject(Object.assign(Error(), { code: "PREFLIGHT_TIMEOUT" }));
      }, timeout);
      child.stdout.on("data", (chunk) => {
        if (output.length < 65536) output += chunk;
      });
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once("exit", (code) => {
        clearTimeout(timer);
        resolve({ code, output });
      });
    });
  }
  try {
    stage = "worker-lock";
    lease = spawn(
      join(root, "host-builds", identity.buildId, "dist/native/suri-helper"),
      ["lock", join(root, "run/restart.lock")],
      { cwd: root, stdio: ["pipe", "pipe", "ignore"] },
    );
    await new Promise((resolve, reject) => {
      let output = "";
      const timer = setTimeout(
        () =>
          reject(
            Object.assign(Error(), { code: "RESTART_WORKER_LOCK_FAILED" }),
          ),
        2000,
      );
      lease.stdout.on("data", (bytes) => {
        output += bytes;
        if (output.trim() === "locked") {
          clearTimeout(timer);
          resolve();
        }
      });
      lease.once("error", () => {
        clearTimeout(timer);
        reject(Object.assign(Error(), { code: "RESTART_WORKER_LOCK_FAILED" }));
      });
      lease.once("exit", (code) => {
        clearTimeout(timer);
        reject(
          Object.assign(Error(), {
            code:
              code === 3
                ? "RESTART_WORKER_ALREADY_RUNNING"
                : "RESTART_WORKER_LOCK_FAILED",
          }),
        );
      });
    });
    stage = "approval";
    await report("PENDING");
    operation = JSON.parse(
      await readFile(join(root, "updates/restart.json"), "utf8"),
    );
    if (
      operation.operationId !== operationId ||
      operation.phase !== "dispatching" ||
      operation.expiresAt <= Date.now() ||
      !/^[a-f0-9]{64}$/.test(operation.targetBuildId)
    )
      fail("RESTART_APPROVAL_INVALID");
    const target = join(root, "host-builds", operation.targetBuildId);
    stage = "preflight";
    await report("PENDING");
    const proof = await run(process.execPath, [
      join(target, "launch.mjs"),
      "--check",
    ]);
    if (
      proof.code ||
      JSON.parse(proof.output).buildId !== operation.targetBuildId
    )
      fail("HOST_TARGET_PREFLIGHT_FAILED");
    stage = "admission";
    await report("PENDING");
    const old = await control({ type: "health" });
    if (
      old.instanceId !== operation.fromInstanceId ||
      old.hostBuildId !== identity.buildId
    )
      fail("HOST_IDENTITY_CHANGED");
    oldHostState = "running";
    await report("PENDING");
    const admitted = await control({
      type: "restart-admit",
      operationId,
      expectedInstanceId: operation.fromInstanceId,
      targetBuildId: operation.targetBuildId,
    });
    if (!admitted.stopping || admitted.instanceId !== operation.fromInstanceId)
      fail(
        admitted.error === "HOST_BUSY"
          ? "HOST_BUSY"
          : "RESTART_ADMISSION_REFUSED",
      );
    oldHostState = "stopping";
    stage = "drain";
    await report("PENDING");
    const helper = join(target, "dist/native/suri-helper");
    const drainDeadline = Date.now() + 15000;
    while (true) {
      const probe = await run(
        helper,
        ["lock", join(root, "run/host.lock")],
        2000,
      );
      if (probe.code === 0 && probe.output.trim() === "locked") break;
      if (probe.code !== 3) fail("HOST_DRAIN_LOCK_UNAVAILABLE");
      if (Date.now() >= drainDeadline) fail("HOST_DRAIN_TIMEOUT");
      await delay(100);
    }
    oldHostState = "stopped";
    stage = "spawn";
    await report("PENDING");
    const child = spawn(
      process.execPath,
      [join(target, "launch.mjs"), "serve"],
      {
        detached: true,
        cwd: root,
        env: { ...process.env, SURI_PORT: new URL(operation.origin).port },
        stdio: "ignore",
      },
    );
    await new Promise((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    child.unref();
    stage = "health";
    await report("PENDING");
    const deadline = Date.now() + 15000;
    let health;
    while (Date.now() < deadline) {
      try {
        health = await control({ type: "health" });
      } catch (error) {
        if (!["ENOENT", "ECONNREFUSED", "ETIMEDOUT"].includes(error.code))
          fail("HOST_HEALTH_TRANSPORT_FAILED");
      }
      if (health) {
        if (health.instanceId === operation.fromInstanceId)
          fail("HOST_IDENTITY_CHANGED");
        if (
          health.pid !== child.pid ||
          health.hostBuildId !== operation.targetBuildId ||
          health.uiBuildId !== operation.uiBuildId ||
          health.product !== "suri-pi" ||
          health.protocol !== 1 ||
          health.uiContract !== 2
        )
          fail("HOST_IDENTITY_CHANGED");
        break;
      }
      // A missing or invalid launch status is treated as no failure report (null); the loop polls again.
      const launch = await readFile(
        join(root, "run/update-launch.json"),
        "utf8",
      )
        .then(JSON.parse)
        .catch(() => null);
      if (launch?.stage === "failed" && launch.pid === child.pid)
        fail(
          launch.code === "HOST_ADDRESS_CONFLICT"
            ? launch.code
            : "HOST_TARGET_START_FAILED",
        );
      await delay(100);
    }
    if (!health) fail("HOST_START_TIMEOUT");
    stage = "bootstrap";
    await report("PENDING");
    const bootstrap = await control({ type: "bootstrap" });
    if (bootstrap.origin !== operation.origin) fail("HOST_ADDRESS_CONFLICT");
    const response = await fetch(bootstrap.origin + "/v1/bootstrap", {
      method: "POST",
      headers: { Origin: bootstrap.origin, "Content-Type": "application/json" },
      body: JSON.stringify({ nonce: bootstrap.nonce }),
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok || !response.headers.has("set-cookie"))
      fail("HOST_REBOOTSTRAP_FAILED");
    // Handoffs remain non-consumable until replacement bootstrap succeeds.
    stage = "handoff-commit";
    await report("PENDING");
    boundInstanceId = health.instanceId;
    // From this point the replacement may have committed even if its control
    // response is lost. Every error therefore takes the identity-bound revoke
    // path, which also invalidates operation-scoped nonces and sessions.
    bindMayHaveCommitted = true;
    const committed = await control({
      type: "restart-handoff-commit",
      operationId,
      targetBuildId: operation.targetBuildId,
      instanceId: health.instanceId,
      workerPid: process.pid,
      fromInstanceId: operation.fromInstanceId,
      oldHostState,
    });
    if (!committed.committed)
      fail(
        committed.error === "HANDOFF_IDENTITY_CHANGED"
          ? committed.error
          : "HANDOFF_BIND_FAILED",
      );
    // Commit serialized binding and terminal VERIFIED evidence against consume.
    // No fallible operation is permitted after this response.
    bindMayHaveCommitted = false;
  } catch (error) {
    if (bindMayHaveCommitted && boundInstanceId) {
      try {
        const status = await control({
          type: "restart-handoff-status",
          operationId,
          targetBuildId: operation.targetBuildId,
          instanceId: boundInstanceId,
        });
        // A lost commit response is success when the replacement proves the
        // exact durable binding. Commit ordering guarantees VERIFIED evidence
        // was persisted before the binding became observable.
        if (status.committed) {
          bindMayHaveCommitted = false;
          return;
        }
      } catch {
        // Status unavailable: fall through to the revoke attempt below.
      }
      try {
        const revoked = await control({
          type: "restart-handoff-revoke",
          operationId,
          targetBuildId: operation.targetBuildId,
          instanceId: boundInstanceId,
        });
        if (!revoked.revoked) throw Error("HANDOFF_REVOKE_FAILED");
      } catch {
        error = Object.assign(Error("HANDOFF_REVOKE_FAILED"), {
          code: "HANDOFF_REVOKE_FAILED",
        });
      }
    }
    const known = [
      "RESTART_APPROVAL_INVALID",
      "RESTART_WORKER_ALREADY_RUNNING",
      "RESTART_WORKER_LOCK_FAILED",
      "HOST_TARGET_PREFLIGHT_FAILED",
      "HOST_IDENTITY_CHANGED",
      "HOST_BUSY",
      "RESTART_ADMISSION_REFUSED",
      "HOST_DRAIN_LOCK_UNAVAILABLE",
      "HOST_DRAIN_TIMEOUT",
      "HOST_HEALTH_TRANSPORT_FAILED",
      "HOST_TARGET_START_FAILED",
      "HOST_ADDRESS_CONFLICT",
      "HOST_START_TIMEOUT",
      "HANDOFF_IDENTITY_CHANGED",
      "HANDOFF_BIND_FAILED",
      "HANDOFF_REVOKE_FAILED",
      "HOST_REBOOTSTRAP_FAILED",
    ];
    const existing =
      // A missing or invalid report (null) means no live owner evidence to protect.
      error.code === "RESTART_WORKER_ALREADY_RUNNING"
        ? await readFile(reportPath, "utf8")
            .then(JSON.parse)
            .catch(() => null)
        : null;
    // A duplicate invocation must not overwrite the live owner's evidence.
    if (existing?.workerPid && existing.workerPid !== process.pid) {
      process.exitCode = 1;
      return;
    }
    // Best effort: failing to write the report must not mask the original failure.
    await report(
      known.includes(error.code)
        ? error.code
        : `RESTART_${stage.toUpperCase().replaceAll("-", "_")}_FAILED`,
    ).catch(() => {});
    process.exitCode = 1;
  } finally {
    lease?.stdin.end();
  }
}
