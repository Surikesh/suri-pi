// Local recovery only. No provider calls, raw logs, credentials or environment dumps.
import { execFile, spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
const exec = promisify(execFile);
const checkout = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function parseProcesses(text) {
  return text
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const fields = line.trim().split(/\s+/);
      if (fields.length < 11) throw Error("PROCESS_SNAPSHOT_INVALID");
      const [pid, parent, group, foreground] = fields.slice(0, 4).map(Number);
      if (![pid, parent, group, foreground].every(Number.isSafeInteger))
        throw Error("PROCESS_SNAPSHOT_INVALID");
      return {
        pid,
        parent,
        group,
        foreground,
        state: fields[4],
        started: fields.slice(5, 10).join(" "),
        executable: fields.slice(10).join(" "),
      };
    });
}
export function terminalCandidates(rows, hostPid) {
  return rows.filter(
    (p) =>
      p.parent === hostPid &&
      ["/bin/zsh", "/bin/bash"].includes(p.executable) &&
      p.group === p.pid &&
      p.foreground === p.group &&
      /^S/.test(p.state) &&
      !rows.some((child) => child.parent === p.pid),
  );
}
export function sameHost(a, b) {
  return (
    Number.isSafeInteger(a?.pid) &&
    a.pid > 1 &&
    typeof a.instanceId === "string" &&
    a.pid === b?.pid &&
    a.instanceId === b?.instanceId
  );
}
export function canClose(candidate, rows, host) {
  return terminalCandidates(rows, host.pid).some(
    (p) =>
      p.pid === candidate.pid &&
      p.started === candidate.started &&
      p.executable === candidate.executable,
  );
}
export function classifyCwd(inode, current, durable) {
  if (inode == null || current == null) return "unknown";
  if (String(inode) !== String(current)) return "stale-directory";
  return durable ? "durable-data-root" : "replaceable-launch-directory";
}

export function boundedFailure(error, stage) {
  const candidate = error?.detail?.code ?? error?.message;
  const safe = new Error(
    typeof candidate === "string" && /^[A-Z][A-Z0-9_]+$/.test(candidate)
      ? candidate
      : "RECOVERY_STEP_FAILED",
  );
  safe.recoveryStage = stage;
  return safe;
}
export async function recover(options, io) {
  io = Object.fromEntries(
    Object.entries(io).map(([stage, fn]) => [
      stage,
      async (...args) => {
        try {
          return await fn(...args);
        } catch (error) {
          throw boundedFailure(error, stage);
        }
      },
    ]),
  );
  const before = await io.health();
  if (
    !Number.isSafeInteger(before.pid) ||
    before.pid <= 1 ||
    !before.instanceId ||
    !Number.isSafeInteger(before.activeWork)
  )
    throw Error("HOST_HEALTH_INVALID");
  const rows = await io.processes();
  const candidates = terminalCandidates(rows, before.pid);
  const report = {
    hostPid: before.pid,
    instanceId: before.instanceId,
    activeWork: before.activeWork,
    cwd: await io.cwd(before.pid),
    terminalCandidates: candidates.map((p) => p.pid),
  };
  if (!options.restart) return { ...report, action: "diagnosed-no-changes" };
  if (before.activeWork > 0) {
    if (!options.closeIdleTerminals)
      return { ...report, action: "blocked-active-work" };
    // Do not close terminals if other active work is also present.
    if (before.activeWork !== candidates.length || candidates.length === 0)
      return { ...report, action: "blocked-nonterminal-work" };
    for (const candidate of candidates) {
      const fresh = await io.health();
      if (!sameHost(before, fresh)) throw Error("HOST_IDENTITY_CHANGED");
      const processes = await io.processes();
      if (!canClose(candidate, processes, before))
        throw Error("TERMINAL_STATE_CHANGED");
      const remaining = terminalCandidates(processes, before.pid);
      if (fresh.activeWork > remaining.length)
        throw Error("ACTIVE_WORK_CHANGED");
      await io.hangup(candidate.pid);
      // Wait for the host to observe terminal exit before checking the next one.
      await io.waitTerminalExit(candidate.pid, before);
    }
  }
  const idle = await io.health();
  if (!sameHost(before, idle)) throw Error("HOST_IDENTITY_CHANGED");
  if (idle.activeWork !== 0) throw Error("HOST_BUSY");
  // The CLI independently checks identity and idle admission, never force-kills.
  await io.restart();
  const after = await io.health();
  if (
    !Number.isSafeInteger(after.pid) ||
    after.pid <= 1 ||
    typeof after.instanceId !== "string" ||
    !after.instanceId ||
    after.instanceId === before.instanceId ||
    after.lifecycle !== "running"
  )
    throw Error("RESTART_NOT_VERIFIED");
  if (!options.noOpen) await io.open();
  return {
    ...report,
    action: options.noOpen ? "restarted-no-client" : "restarted-and-opened",
    newHostPid: after.pid,
    newInstanceId: after.instanceId,
    cwd: await io.cwd(after.pid),
  };
}

async function main() {
  const args = process.argv.slice(2);
  if (
    args.some(
      (a) => !["--restart", "--close-idle-terminals", "--no-open"].includes(a),
    ) ||
    (args.includes("--close-idle-terminals") && !args.includes("--restart"))
  )
    throw Error("RECOVERY_ARGUMENTS_INVALID");
  if (process.platform !== "darwin")
    throw Error("RECOVERY_PLATFORM_UNSUPPORTED");
  if (process.versions.node !== "24.15.0") {
    const pinned = join(
      checkout,
      ".runtime/node/node-v24.15.0-darwin-arm64/bin/node",
    );
    // An unrunnable pinned node (null) is reported as PINNED_NODE_REQUIRED below.
    const version = await exec(pinned, ["--version"], { timeout: 5000 }).catch(
      () => null,
    );
    if (version?.stdout.trim() !== "v24.15.0")
      throw Error("PINNED_NODE_REQUIRED");
    await new Promise((done, reject) => {
      const child = spawn(pinned, [fileURLToPath(import.meta.url), ...args], {
        stdio: "inherit",
        env: {
          ...process.env,
          PATH: dirname(pinned) + ":" + (process.env.PATH ?? "/usr/bin:/bin"),
        },
      });
      child.once("error", () => reject(Error("PINNED_NODE_LAUNCH_FAILED")));
      child.once("exit", (code) => {
        process.exitCode = code ?? 1;
        done();
      });
    });
    return;
  }
  process.env.PATH =
    dirname(process.execPath) + ":" + (process.env.PATH ?? "/usr/bin:/bin");
  const root = resolve(
    process.env.SURI_DATA_DIR ??
      join(homedir(), "Library/Application Support/Suri Pi"),
  );
  if (
    // A missing built host (null) is reported as BUILT_HOST_MISSING below.
    !(await stat(join(checkout, "dist/apps/host/src/cli.js")).catch(() => null))
  )
    throw Error("BUILT_HOST_MISSING");
  const { control } = await import(
    pathToFileURL(join(checkout, "dist/apps/host/src/cli.js")).href
  );
  const health = () => control(root, { type: "health" });
  const processes = async () =>
    parseProcesses(
      (
        await exec(
          "/bin/ps",
          ["-axo", "pid=,ppid=,pgid=,tpgid=,stat=,lstart=,comm="],
          { timeout: 5000, maxBuffer: 2 * 1024 * 1024 },
        )
      ).stdout,
    );
  const cwd = async (pid) => {
    try {
      const lines = (
        await exec(
          "/usr/sbin/lsof",
          ["-a", "-p", String(pid), "-d", "cwd", "-Fin"],
          { timeout: 5000 },
        )
      ).stdout.split("\n");
      const path = lines.find((l) => l.startsWith("n"))?.slice(1);
      const inode = lines.find((l) => l.startsWith("i"))?.slice(1);
      if (!path || !inode) return "unknown";
      // A cwd that no longer exists (null) is classified by classifyCwd.
      const current = await stat(path).catch(() => null);
      const data = await stat(root);
      return classifyCwd(
        inode,
        current?.ino ?? -1,
        current?.ino === data.ino && current?.dev === data.dev,
      );
    } catch {
      return "unknown";
    }
  };
  const runCli = async (arguments_) => {
    const result = await exec(
      process.execPath,
      [join(checkout, "dist/apps/host/src/cli.js"), ...arguments_],
      {
        cwd: checkout,
        env: { ...process.env, SURI_DATA_DIR: root },
        timeout: 30000,
      },
    );
    return JSON.parse(result.stdout);
  };
  const result = await recover(
    {
      restart: args.includes("--restart"),
      noOpen: args.includes("--no-open"),
      closeIdleTerminals: args.includes("--close-idle-terminals"),
    },
    {
      health,
      processes,
      cwd,
      hangup: (pid) => process.kill(pid, "SIGHUP"),
      waitTerminalExit: async (pid, before) => {
        for (let i = 0; i < 50; i++) {
          if (!sameHost(before, await health()))
            throw Error("HOST_IDENTITY_CHANGED");
          if (!(await processes()).some((p) => p.pid === pid)) return;
          await new Promise((r) => setTimeout(r, 100));
        }
        throw Error("TERMINAL_EXIT_TIMEOUT");
      },
      restart: async () => {
        if ((await runCli(["restart", "--no-open"])).restarted !== true)
          throw Error("RESTART_NOT_VERIFIED");
      },
      open: async () => {
        await exec(process.execPath, [join(checkout, "scripts/browser.mjs")], {
          cwd: checkout,
          env: { ...process.env, SURI_DATA_DIR: root },
          timeout: 30000,
        });
      },
    },
  );
  console.log(JSON.stringify(result, null, 2));
  if (result.action.startsWith("blocked-")) process.exitCode = 2;
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main().catch((error) => {
    // Never print child stderr/stdout or stack (may include bootstrap material).
    const category = boundedFailure(error, "preflight-or-policy").message;
    console.error(
      JSON.stringify({
        action: "stopped",
        stage: error.recoveryStage ?? "preflight-or-policy",
        category,
      }),
    );
    process.exitCode = 1;
  });
}
