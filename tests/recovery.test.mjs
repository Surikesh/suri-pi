import { test } from "node:test";
import assert from "node:assert/strict";
import {
  recover,
  parseProcesses,
  terminalCandidates,
  classifyCwd,
} from "../scripts/recover.mjs";

const host = {
  pid: 100,
  instanceId: "instance-a",
  activeWork: 0,
  lifecycle: "running",
};
const shell = {
  pid: 200,
  parent: 100,
  group: 200,
  foreground: 200,
  state: "Ss+",
  started: "Mon Sep 21 01:00:00 2026",
  executable: "/bin/zsh",
};
function fixture(active = 0) {
  let current = { ...host, activeWork: active };
  let rows = active ? [{ ...shell }] : [];
  const calls = [];
  return {
    calls,
    io: {
      health: async () => ({ ...current }),
      processes: async () => rows,
      cwd: async () => "durable-data-root",
      hangup: async (pid) => {
        calls.push(["hangup", pid]);
        rows = [];
        current.activeWork = 0;
      },
      waitTerminalExit: async () => {},
      restart: async () => {
        calls.push(["restart"]);
        current = { ...host, pid: 101, instanceId: "instance-b" };
      },
      open: async () => {
        calls.push(["open"]);
      },
    },
  };
}
test("default is diagnostic-only even with stale cwd and live terminals", async () => {
  const f = fixture(1);
  f.io.cwd = async () => "stale-directory";
  const result = await recover({}, f.io);
  assert.equal(result.cwd, "stale-directory");
  assert.equal(result.action, "diagnosed-no-changes");
  assert.deepEqual(result.terminalCandidates, [200]);
  assert.deepEqual(f.calls, []);
});
test("busy restart never closes terminals without explicit opt-in", async () => {
  const f = fixture(1);
  assert.equal(
    (await recover({ restart: true }, f.io)).action,
    "blocked-active-work",
  );
  assert.deepEqual(f.calls, []);
});
test("idle restart verifies replacement then opens authenticated client", async () => {
  const f = fixture();
  assert.equal(
    (await recover({ restart: true }, f.io)).action,
    "restarted-and-opened",
  );
  assert.deepEqual(f.calls, [["restart"], ["open"]]);
});
test("explicit terminal close only signals verified idle owned shell", async () => {
  const f = fixture(1);
  await recover({ restart: true, closeIdleTerminals: true }, f.io);
  assert.deepEqual(f.calls, [["hangup", 200], ["restart"], ["open"]]);
});
test("active nonterminal work blocks even with terminal-close opt-in", async () => {
  const f = fixture(2);
  assert.equal(
    (await recover({ restart: true, closeIdleTerminals: true }, f.io)).action,
    "blocked-nonterminal-work",
  );
  assert.deepEqual(f.calls, []);
});
test("ownership, foreground, active child, state and executable are mandatory", () => {
  for (const change of [
    { parent: 99 },
    { foreground: 201 },
    { group: 201 },
    { state: "R+" },
    { executable: "/bin/other" },
  ])
    assert.deepEqual(terminalCandidates([{ ...shell, ...change }], 100), []);
  assert.deepEqual(
    terminalCandidates([shell, { ...shell, pid: 201, parent: 200 }], 100),
    [],
  );
});
test("PID reuse blocks signal and restart", async () => {
  const f = fixture(1);
  let calls = 0;
  f.io.processes = async () => [
    { ...shell, started: calls++ ? "different-start" : shell.started },
  ];
  await assert.rejects(
    recover({ restart: true, closeIdleTerminals: true }, f.io),
    /TERMINAL_STATE_CHANGED/,
  );
  assert.deepEqual(f.calls, []);
});
test("host identity change blocks signal and restart", async () => {
  const f = fixture(1);
  let calls = 0;
  f.io.health = async () => ({
    ...host,
    activeWork: 1,
    instanceId: calls++ ? "changed" : host.instanceId,
  });
  await assert.rejects(
    recover({ restart: true, closeIdleTerminals: true }, f.io),
    /HOST_IDENTITY_CHANGED/,
  );
  assert.deepEqual(f.calls, []);
});
test("new active work between initial check and restart is rejected", async () => {
  const f = fixture();
  let calls = 0;
  f.io.health = async () => ({ ...host, activeWork: calls++ ? 1 : 0 });
  await assert.rejects(recover({ restart: true }, f.io), /HOST_BUSY/);
  assert.deepEqual(f.calls, []);
});
test("terminal timeout never escalates to kill or host restart", async () => {
  const f = fixture(1);
  f.io.waitTerminalExit = async () => {
    throw Error("TERMINAL_EXIT_TIMEOUT");
  };
  await assert.rejects(
    recover({ restart: true, closeIdleTerminals: true }, f.io),
    /TERMINAL_EXIT_TIMEOUT/,
  );
  assert.deepEqual(f.calls, [["hangup", 200]]);
});
test("unchanged host identity never reports restart success", async () => {
  const f = fixture();
  f.io.restart = async () => {};
  await assert.rejects(
    recover({ restart: true }, f.io),
    /RESTART_NOT_VERIFIED/,
  );
  assert.deepEqual(f.calls, []);
});
test("process parser retains start identity and rejects malformed fields", () => {
  assert.deepEqual(
    parseProcesses("200 100 200 200 Ss+ Mon Sep 21 01:00:00 2026 /bin/zsh\n"),
    [shell],
  );
  assert.throws(
    () => parseProcesses("bad snapshot"),
    /PROCESS_SNAPSHOT_INVALID/,
  );
});
test("stage-specific failure excludes raw subprocess output", async () => {
  const f = fixture();
  f.io.restart = async () => {
    throw new Error("SECRET raw output");
  };
  await assert.rejects(recover({ restart: true }, f.io), (error) => {
    assert.equal(error.message, "RECOVERY_STEP_FAILED");
    assert.equal(error.recoveryStage, "restart");
    assert.ok(!JSON.stringify(error).includes("SECRET"));
    return true;
  });
  assert.deepEqual(f.calls, []);
});
test("no-open never claims client activation", async () => {
  const f = fixture();
  assert.equal(
    (await recover({ restart: true, noOpen: true }, f.io)).action,
    "restarted-no-client",
  );
  assert.deepEqual(f.calls, [["restart"]]);
});
test("cwd inode mismatch is distinguished from replaceable and durable dirs", () => {
  assert.equal(classifyCwd("123", 456, false), "stale-directory");
  assert.equal(classifyCwd("123", 123, false), "replaceable-launch-directory");
  assert.equal(classifyCwd("123", 123, true), "durable-data-root");
  assert.equal(classifyCwd(null, null, false), "unknown");
});
