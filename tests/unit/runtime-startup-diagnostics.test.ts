import { afterEach, describe, expect, it } from "vitest";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import {
  PiClient,
  type RuntimeStartupDiagnostic,
} from "../../packages/pi-adapter/src/index.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function fixture(source: string) {
  const root = await mkdtemp(join(tmpdir(), "suri-startup-diagnostic-"));
  roots.push(root);
  const executable = join(root, "pi-fixture.mjs");
  await writeFile(executable, `#!/usr/bin/env node\n${source}\n`, {
    mode: 0o700,
  });
  await chmod(executable, 0o700);
  return { root, executable };
}

// Normal exit classification must not race a contended child startup in the
// parallel unit suite. The explicit timeout case below retains its 20 ms bound.
async function run(source: string, timeout = 12000) {
  const { root, executable } = await fixture(source);
  const diagnostics: RuntimeStartupDiagnostic[] = [];
  const events: unknown[] = [];
  const client = new PiClient(
    {
      executable,
      cwd: root,
      sessionDir: root,
      startup: {
        trigger: "explicit-create",
        diagnostic: (value) => diagnostics.push(value),
      },
    },
    (type, payload) => events.push({ type, payload }),
  );
  let error: unknown;
  try {
    await client.request("get_state", {}, timeout);
  } catch (value) {
    error = value;
  }
  if (client.child.exitCode === null && client.child.signalCode === null)
    client.forceStop();
  await client.exited;
  return { diagnostics, events, error };
}

describe("runtime startup diagnostics", () => {
  it.each([
    [
      "process.stderr.write('Error: ENOTTY synthetic-secret'); process.exit(1)",
      "enotty",
      1,
    ],
    ["process.exit(0)", "unknown", 0],
    ["process.kill(process.pid, 'SIGTERM')", "unknown", undefined],
    [
      "process.stderr.write('extension factory failed synthetic-secret'); process.exit(1)",
      "extension-load",
      1,
    ],
  ])(
    "classifies one terminal startup result without leaking stderr",
    async (source, category, exitCode) => {
      const result = await run(source);
      expect(result.diagnostics).toHaveLength(1);
      expect(result.diagnostics[0]).toMatchObject({
        trigger: "explicit-create",
        stage: "rpc-readiness",
        category,
        readinessReached: false,
        ...(exitCode === undefined ? { signal: "SIGTERM" } : { exitCode }),
      });
      expect(JSON.stringify(result)).not.toContain("synthetic-secret");
    },
  );

  it.each(["ENOENT", "EACCES"])(
    "survives private-control spawn %s and revokes exactly once",
    async (spawnCode) => {
      const root = await mkdtemp(join(tmpdir(), "suri-startup-spawn-"));
      roots.push(root);
      const executable = join(root, "pi-fixture");
      if (spawnCode === "EACCES") {
        await writeFile(executable, "#!/bin/sh\nexit 0\n", { mode: 0o600 });
        await chmod(executable, 0o600);
      }
      const diagnostics: RuntimeStartupDiagnostic[] = [];
      let revocations = 0;
      const client = new PiClient(
        {
          executable,
          cwd: root,
          sessionDir: root,
          privateControl: {
            handshake: "synthetic-handshake",
            handle: async () => undefined,
            close: () => {
              revocations += 1;
            },
          },
          startup: {
            trigger: "explicit-resume",
            diagnostic: (value) => diagnostics.push(value),
          },
        },
        () => {},
      );
      await expect(client.request("get_state")).rejects.toMatchObject({
        code: "RUNTIME_UNAVAILABLE",
      });
      await client.exited;
      await new Promise((resolve) => setImmediate(resolve));
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0]).toMatchObject({
        category: "spawn",
        spawnCode,
      });
      expect(revocations).toBe(1);
    },
  );

  it("does not treat an error event after confirmed spawn as process exit", async () => {
    const { root, executable } = await fixture(`
let input=''; process.stdin.on('data', chunk => { input += chunk; while(input.includes('\\n')) { const i=input.indexOf('\\n'); const request=JSON.parse(input.slice(0,i)); input=input.slice(i+1); process.stdout.write(JSON.stringify({type:'response',id:request.id,command:request.type,success:true,data:{}})+'\\n'); }});
`);
    const diagnostics: RuntimeStartupDiagnostic[] = [];
    const client = new PiClient(
      {
        executable,
        cwd: root,
        sessionDir: root,
        startup: {
          trigger: "explicit-resume",
          diagnostic: (value) => diagnostics.push(value),
        },
      },
      () => {},
    );
    await once(client.child, "spawn");
    client.child.emit(
      "error",
      Object.assign(new Error("synthetic post-spawn error"), { code: "EIO" }),
    );
    await expect(client.request("get_state")).resolves.toEqual({});
    expect(diagnostics).toEqual([]);
    expect(client.child.exitCode).toBeNull();
    client.close();
    await client.exited;
  });

  it("bounds sensitive stderr and reports readiness timeout once", async () => {
    const result = await run(
      "process.stderr.write('synthetic-secret'.repeat(2000)); setInterval(()=>{},1000)",
      20,
    );
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]).toMatchObject({
      category: "timeout",
      stage: "rpc-readiness",
    });
    expect(JSON.stringify(result)).not.toContain("synthetic-secret");
  });

  it("keeps startup open through model application and reports a categorical exit", async () => {
    const { root, executable } = await fixture(`
let input=''; process.stdin.on('data', chunk => { input += chunk; while(input.includes('\\n')) { const i=input.indexOf('\\n'); const request=JSON.parse(input.slice(0,i)); input=input.slice(i+1); if(request.type==='get_state') process.stdout.write(JSON.stringify({type:'response',id:request.id,command:request.type,success:true,data:{}})+'\\n'); else { process.stderr.write('extension factory failed hidden-value'); setTimeout(()=>process.exit(7),10); } }});
`);
    const diagnostics: RuntimeStartupDiagnostic[] = [];
    const client = new PiClient(
      {
        executable,
        cwd: root,
        sessionDir: root,
        startup: {
          trigger: "explicit-resume",
          diagnostic: (value) => diagnostics.push(value),
        },
      },
      () => {},
    );
    await client.request("get_state");
    await expect(
      client.request("set_model", { provider: "x", modelId: "y" }, 200),
    ).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
    await client.exited;
    expect(diagnostics).toEqual([
      expect.objectContaining({
        stage: "model-apply",
        readinessReached: true,
        exitCode: 7,
        category: "extension-load",
      }),
    ]);
    expect(JSON.stringify(diagnostics)).not.toContain("hidden-value");
  });

  it("preserves a failed host phase while delayed cleanup exits", async () => {
    const { root, executable } = await fixture(
      "process.stdin.resume(); process.stdin.on('end',()=>setTimeout(()=>process.exit(0),30))",
    );
    const phases: string[] = [];
    const client = new PiClient(
      {
        executable,
        cwd: root,
        sessionDir: root,
        startup: { trigger: "explicit-create" },
      },
      (type, payload) => {
        if (type === "session.state") phases.push(String(payload.phase));
      },
    );
    await expect(client.request("get_state", {}, 10)).rejects.toMatchObject({
      code: "INDETERMINATE",
    });
    client.close(true);
    await client.exited;
    expect(phases).not.toContain("closed");
  });

  it("treats malformed stdout as a bounded protocol fault", async () => {
    const result = await run(
      "process.stdout.write('not-json\\n'); setTimeout(()=>process.exit(1),10)",
    );
    expect(JSON.stringify(result.events)).not.toContain("not-json");
    expect(result.events).toContainEqual({
      type: "notice",
      payload: expect.objectContaining({ code: "MALFORMED_RPC" }),
    });
    expect(result.diagnostics).toHaveLength(1);
  });
});
