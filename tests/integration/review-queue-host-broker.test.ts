import { afterEach, describe, expect, it } from "vitest";
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { startHost } from "../../apps/host/src/host.js";

const roots: string[] = [];
async function waitFor(check: () => boolean, message: string, attempts = 300) {
  for (let i = 0; i < attempts; i++) {
    if (check()) return;
    await new Promise((done) => setTimeout(done, 10));
  }
  throw new Error(message);
}
async function resumeReceipt(
  host: Awaited<ReturnType<typeof startHost>>,
  id: string,
) {
  const commandId = randomUUID();
  const initial = await host.execute(
    {
      v: 1,
      id: commandId,
      createdAt: new Date().toISOString(),
      type: "session.resume",
      sessionId: id,
      payload: {},
    },
    "fixture",
  );
  if (initial.status !== "accepted") return initial;
  await waitFor(
    () => host.store.commandReceipt(commandId)?.status !== "accepted",
    `resume ${id} did not become terminal`,
  );
  return host.store.commandReceipt(commandId)!;
}
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("review queue authenticated host worker", () => {
  it.runIf(process.platform === "darwin")(
    "launches an exact no-builtins worker whose writes cross the fenced broker",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "suri-queue-host-"));
      roots.push(root);
      const workspace = join(root, "workspace");
      await mkdir(workspace);
      const targetSessionId = randomUUID();
      const executable = join(root, "fake-pi.mjs");
      const resultFile = join(root, "queue-result.json");
      const outsideFile = join(root, "outside.txt");
      await writeFile(outsideFile, "secret");
      await writeFile(
        executable,
        `#!/usr/bin/env node
import fs from 'node:fs'; import path from 'node:path'; import {createHmac,randomUUID} from 'node:crypto';
const sessionDir=process.argv[process.argv.indexOf('--session-dir')+1], worker=process.argv.includes('--no-builtin-tools'), sessionFile=path.join(sessionDir,'fixture.jsonl'), piSessionId=randomUUID();
let stdin='';process.stdin.on('end',()=>process.exit(0));process.stdin.on('data',b=>{stdin+=b;while(stdin.includes('\\n')){const i=stdin.indexOf('\\n'),line=stdin.slice(0,i);stdin=stdin.slice(i+1);if(!line)continue;const q=JSON.parse(line);let data={};if(q.type==='get_state')data={sessionId:piSessionId,sessionFile,model:{provider:'openai-codex',id:'fixture'},thinkingLevel:'low'};process.stdout.write(JSON.stringify({type:'response',id:q.id,command:q.type,success:true,data})+'\\n');}});
let buffer='',key,channel,requestCounter=0,responseCounter=0,pending=[];const stream=fs.createReadStream(null,{fd:3,autoClose:false});
const mac=(counter,payload)=>createHmac('sha256',key).update(JSON.stringify([1,channel,counter,payload])).digest('base64url');
const send=payload=>new Promise((resolve,reject)=>{pending.push({resolve,reject});const counter=++requestCounter;fs.writeSync(3,JSON.stringify({v:1,channelId:channel,counter,payload,mac:mac(counter,payload)})+'\\n');});
stream.on('data',b=>{buffer+=b;while(buffer.includes('\\n')){const i=buffer.indexOf('\\n'),line=buffer.slice(0,i);buffer=buffer.slice(i+1);if(!key){const h=JSON.parse(line);key=Buffer.from(h.key,'base64url');channel=h.channelId;void run().catch(e=>fs.writeFileSync(${JSON.stringify(resultFile)},JSON.stringify({error:String(e?.stack||e)})));continue;}const f=JSON.parse(line);if(f.counter!==++responseCounter||f.mac!==mac(f.counter,f.payload))process.exit(9);pending.shift()?.resolve(f.payload);}});
async function run(){if(worker){const escaped=await send({protocol:'suri-review-queue-worker-v1',operation:'exec',executable:'/bin/sh',args:['-c',${JSON.stringify(`printf escaped > ${outsideFile}`)}]});const readOutside=await send({protocol:'suri-review-queue-worker-v1',operation:'exec',executable:'/bin/cat',args:[${JSON.stringify(outsideFile)}]});const result=await send({protocol:'suri-review-queue-worker-v1',operation:'write',target:'owned-by-worker.txt',bytes:'mediated'});fs.writeFileSync(${JSON.stringify(resultFile)},JSON.stringify({worker:result,escaped,readOutside,args:process.argv.slice(2)}));return;}const capabilities=await send({protocol:'suri-review-queue-control-v1',operation:'capabilities'});if(!capabilities.ok)throw Error('capabilities '+JSON.stringify(capabilities));const launch=await send({protocol:'suri-review-queue-control-v1',operation:'launch_implementer',key:'launch-1',targetSessionId:${JSON.stringify(targetSessionId)},epoch:1});if(!launch.ok)throw Error('launch '+JSON.stringify(launch));}
`,
        { mode: 0o700 },
      );
      await chmod(executable, 0o700);
      const host = await startHost({
        root: join(root, "data"),
        assets: resolve("dist/ui"),
        helper: resolve("dist/native/suri-helper"),
        simulated: true,
        reviewQueueExtension: resolve(
          "packages/pi-adapter/src/review-queue-extension.ts",
        ),
      });
      try {
        const projectId = randomUUID();
        const workspaceId = randomUUID();
        const runtimeId = randomUUID();
        host.store.put("project", {
          id: projectId,
          root: workspace,
          label: "fixture",
          revision: 1,
        });
        host.store.put("workspace", {
          id: workspaceId,
          projectId,
          root: workspace,
          label: "fixture",
          revision: 1,
        });
        host.store.put("runtime", {
          id: runtimeId,
          executable,
          version: "0.85.1",
          identity: "fixture",
          status: "verified",
          revision: 1,
        });
        host.store.put("session", {
          id: "source",
          workspaceId,
          runtimeId,
          name: "source",
          revision: 1,
          archived: false,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });
        const resumed = await host.execute(
          {
            v: 1,
            id: randomUUID(),
            createdAt: new Date().toISOString(),
            type: "session.resume",
            sessionId: "source",
            payload: {},
          },
          "fixture",
        );
        expect(resumed.status).toBe("accepted");
        let result: any;
        for (let i = 0; i < 200; i++) {
          try {
            result = JSON.parse(await readFile(resultFile, "utf8"));
            break;
          } catch {
            await new Promise((done) => setTimeout(done, 20));
          }
        }
        if (!result)
          throw new Error(
            `queue fixture did not respond: ${JSON.stringify({
              sessions: host.store.list("session"),
              children: [...host.children.keys()],
              target: host.store.snapshot(`session:${targetSessionId}`),
            })}`,
          );
        expect(result).not.toHaveProperty("error");
        expect(result.worker).toEqual({ ok: true });
        expect(result.escaped).toMatchObject({
          ok: false,
          category: "process_denied",
        });
        expect(result.readOutside.result.exitCode).not.toBe(0);
        expect(result.readOutside.result.stdout).not.toContain("secret");
        expect(await readFile(outsideFile, "utf8")).toBe("secret");
        expect(result.args).toEqual(
          expect.arrayContaining([
            "--no-extensions",
            "--no-builtin-tools",
            "--no-skills",
            "--no-context-files",
            "queue_read,queue_write,queue_exec",
          ]),
        );
        expect(
          await readFile(join(workspace, "owned-by-worker.txt"), "utf8"),
        ).toBe("mediated");
        expect(host.reviewQueueHost.binding(targetSessionId)).toMatchObject({
          role: "implementer",
          epoch: 1,
        });
        const durable = host.store.get("session", targetSessionId).queueWorker;
        expect(durable).toMatchObject({
          schema: 1,
          role: "implementer",
          epoch: 1,
          state: "active",
        });
        expect(durable.profileArgs).toEqual(
          host.reviewQueueHost.args(targetSessionId),
        );
        expect(await resumeReceipt(host, targetSessionId)).toMatchObject({
          status: "rejected",
        });
        expect(host.children.has(targetSessionId)).toBe(true);

        host.children.get(targetSessionId)!.forceStop();
        await waitFor(
          () => !host.children.has(targetSessionId),
          "crashed queue worker remained active",
        );
        expect(await resumeReceipt(host, targetSessionId)).toMatchObject({
          status: "rejected",
        });

        const sourceAuthority = durable.authority;
        const revokedTargetId = randomUUID();
        expect(
          await host.reviewQueueHost.handleControl(sourceAuthority, {
            protocol: "suri-review-queue-control-v1",
            operation: "launch_implementer",
            key: "launch-after-crash",
            targetSessionId: revokedTargetId,
            epoch: 2,
          }),
        ).toMatchObject({ ok: true, hostSessionId: revokedTargetId });
        const sourceClient = host.children.get("source")!;
        sourceClient.forceStop();
        await sourceClient.exited;
        await waitFor(
          () => !host.children.has(revokedTargetId),
          "source revocation did not terminate its queue worker",
        );
        expect(await resumeReceipt(host, revokedTargetId)).toMatchObject({
          status: "rejected",
        });
        for (const session of host.store.list("session"))
          await host.execute(
            {
              v: 1,
              id: randomUUID(),
              createdAt: new Date().toISOString(),
              type: "session.close",
              sessionId: session.id,
              payload: {},
            },
            "fixture",
          );
      } finally {
        const remaining = [...host.children.values()];
        for (const child of remaining) child.forceStop();
        await Promise.all(remaining.map((child) => child.exited));
        await host.close();
      }
    },
  );

  it.runIf(process.platform === "darwin")(
    "rejects an existing reserved target and reports asynchronous worker boot failure",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "suri-queue-host-failure-"));
      roots.push(root);
      const workspace = join(root, "workspace");
      await mkdir(workspace);
      const executable = join(root, "failing-pi.mjs");
      await writeFile(
        executable,
        `#!/usr/bin/env node
let input='';process.stdin.on('data',b=>{input+=b;while(input.includes('\\n')){const i=input.indexOf('\\n'),line=input.slice(0,i);input=input.slice(i+1);if(!line)continue;const q=JSON.parse(line);process.stdout.write(JSON.stringify({type:'response',id:q.id,command:q.type,success:false,error:'synthetic boot failure'})+'\\n');}});process.stdin.on('end',()=>process.exit(0));
`,
        { mode: 0o700 },
      );
      await chmod(executable, 0o700);
      const host = await startHost({
        root: join(root, "data"),
        assets: resolve("dist/ui"),
        helper: resolve("dist/native/suri-helper"),
        simulated: true,
        reviewQueueExtension: resolve(
          "packages/pi-adapter/src/review-queue-extension.ts",
        ),
      });
      try {
        const projectId = randomUUID();
        const workspaceId = randomUUID();
        const runtimeId = randomUUID();
        const sourceSessionId = randomUUID();
        const existingTargetId = randomUUID();
        host.store.put("project", {
          id: projectId,
          root: workspace,
          label: "fixture",
          revision: 1,
        });
        host.store.put("workspace", {
          id: workspaceId,
          projectId,
          root: workspace,
          label: "fixture",
          revision: 1,
        });
        host.store.put("runtime", {
          id: runtimeId,
          executable,
          version: "0.85.1",
          identity: "fixture",
          status: "verified",
          revision: 1,
        });
        for (const id of [sourceSessionId, existingTargetId])
          host.store.put("session", {
            id,
            workspaceId,
            runtimeId,
            name: id === sourceSessionId ? "source" : "existing inactive",
            revision: 1,
            archived: false,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          });
        const source = {
          sourceHostSessionId: sourceSessionId,
          sourceChannelId: randomUUID(),
          workspaceId,
          repository: await realpath(workspace),
          runtimeId,
        };
        expect(
          await host.reviewQueueHost.handleControl(source, {
            protocol: "suri-review-queue-control-v1",
            operation: "launch_implementer",
            key: "existing-target",
            targetSessionId: existingTargetId,
            epoch: 1,
          }),
        ).toMatchObject({ ok: false, category: "target_session_collision" });
        const failedTargetId = randomUUID();
        expect(
          await host.reviewQueueHost.handleControl(source, {
            protocol: "suri-review-queue-control-v1",
            operation: "launch_implementer",
            key: "boot-failure",
            targetSessionId: failedTargetId,
            epoch: 1,
          }),
        ).toMatchObject({ ok: false, category: "worker_boot_failed" });
        expect(
          host.store
            .list("session")
            .some((session) => session.id === failedTargetId),
        ).toBe(false);
        expect(await resumeReceipt(host, failedTargetId)).toMatchObject({
          status: "rejected",
        });
        expect(host.store.get("session", existingTargetId).name).toBe(
          "existing inactive",
        );
      } finally {
        const remaining = [...host.children.values()];
        for (const child of remaining) child.forceStop();
        await Promise.all(remaining.map((child) => child.exited));
        await host.close();
      }
    },
  );

  it.runIf(process.platform === "darwin")(
    "retires a timed-out asynchronous queue boot before its delayed completion",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "suri-queue-host-timeout-"));
      roots.push(root);
      const workspace = join(root, "workspace");
      await mkdir(workspace);
      const executable = join(root, "delayed-pi.mjs");
      await writeFile(
        executable,
        `#!/usr/bin/env node
let input='';process.stdin.on('data',b=>{input+=b;while(input.includes('\\n')){const i=input.indexOf('\\n'),line=input.slice(0,i);input=input.slice(i+1);if(!line)continue;const q=JSON.parse(line);setTimeout(()=>process.stdout.write(JSON.stringify({type:'response',id:q.id,command:q.type,success:true,data:{sessionId:'late',sessionFile:null}})+'\\n'),200);}});process.stdin.on('end',()=>process.exit(0));
`,
        { mode: 0o700 },
      );
      await chmod(executable, 0o700);
      const host = await startHost({
        root: join(root, "data"),
        assets: resolve("dist/ui"),
        helper: resolve("dist/native/suri-helper"),
        simulated: true,
        reviewQueueExtension: resolve(
          "packages/pi-adapter/src/review-queue-extension.ts",
        ),
        reviewQueueBootTimeoutMs: 20,
      });
      try {
        const projectId = randomUUID();
        const workspaceId = randomUUID();
        const runtimeId = randomUUID();
        const sourceSessionId = randomUUID();
        host.store.put("project", {
          id: projectId,
          root: workspace,
          label: "fixture",
          revision: 1,
        });
        host.store.put("workspace", {
          id: workspaceId,
          projectId,
          root: workspace,
          label: "fixture",
          revision: 1,
        });
        host.store.put("runtime", {
          id: runtimeId,
          executable,
          version: "0.85.1",
          identity: "fixture",
          status: "verified",
          revision: 1,
        });
        host.store.put("session", {
          id: sourceSessionId,
          workspaceId,
          runtimeId,
          name: "source",
          revision: 1,
          archived: false,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });
        const targetSessionId = randomUUID();
        expect(
          await host.reviewQueueHost.handleControl(
            {
              sourceHostSessionId: sourceSessionId,
              sourceChannelId: randomUUID(),
              workspaceId,
              repository: await realpath(workspace),
              runtimeId,
            },
            {
              protocol: "suri-review-queue-control-v1",
              operation: "launch_implementer",
              key: "delayed-boot",
              targetSessionId,
              epoch: 1,
            },
          ),
        ).toMatchObject({ ok: false, category: "worker_boot_timeout" });
        await new Promise((done) => setTimeout(done, 250));
        expect(host.children.has(targetSessionId)).toBe(false);
        expect(
          host.store
            .list("session")
            .some((session) => session.id === targetSessionId),
        ).toBe(false);
        expect(await resumeReceipt(host, targetSessionId)).toMatchObject({
          status: "rejected",
        });
      } finally {
        const remaining = [...host.children.values()];
        for (const child of remaining) child.forceStop();
        await Promise.all(remaining.map((child) => child.exited));
        await host.close();
      }
    },
  );

  it.runIf(process.platform === "darwin")(
    "creates a queue worker only in the exact authenticated aliased workspace",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "suri-queue-host-alias-"));
      roots.push(root);
      const workspace = join(root, "workspace");
      const alias = join(root, "workspace-alias");
      await mkdir(workspace);
      await symlink(workspace, alias);
      const executable = join(root, "fake-pi.mjs");
      await writeFile(
        executable,
        `#!/usr/bin/env node
let input='';process.stdin.on('data',b=>{input+=b;while(input.includes('\\n')){const i=input.indexOf('\\n'),line=input.slice(0,i);input=input.slice(i+1);if(!line)continue;const q=JSON.parse(line);process.stdout.write(JSON.stringify({type:'response',id:q.id,command:q.type,success:true,data:{sessionId:'fixture',sessionFile:null}})+'\\n');}});process.stdin.on('end',()=>process.exit(0));
`,
        { mode: 0o700 },
      );
      await chmod(executable, 0o700);
      const hostOptions = {
        root: join(root, "data"),
        assets: resolve("dist/ui"),
        helper: resolve("dist/native/suri-helper"),
        simulated: true,
        reviewQueueExtension: resolve(
          "packages/pi-adapter/src/review-queue-extension.ts",
        ),
      };
      let host = await startHost(hostOptions);
      try {
        const projectId = randomUUID();
        const workspaceA = randomUUID();
        const workspaceB = randomUUID();
        const runtimeId = randomUUID();
        const sourceSessionId = randomUUID();
        host.store.put("project", {
          id: projectId,
          root,
          label: "fixture",
          revision: 1,
        });
        for (const [id, path] of [
          [workspaceA, workspace],
          [workspaceB, alias],
        ])
          host.store.put("workspace", {
            id,
            projectId,
            root: path,
            label: id,
            revision: 1,
          });
        host.store.put("runtime", {
          id: runtimeId,
          executable,
          version: "0.85.1",
          identity: "fixture",
          status: "verified",
          revision: 1,
        });
        host.store.put("session", {
          id: sourceSessionId,
          workspaceId: workspaceB,
          runtimeId,
          name: "source B",
          revision: 1,
          archived: false,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });
        const targetSessionId = randomUUID();
        expect(
          await host.reviewQueueHost.handleControl(
            {
              sourceHostSessionId: sourceSessionId,
              sourceChannelId: randomUUID(),
              workspaceId: workspaceB,
              repository: await realpath(alias),
              runtimeId,
            },
            {
              protocol: "suri-review-queue-control-v1",
              operation: "launch_implementer",
              key: "workspace-b",
              targetSessionId,
              epoch: 1,
            },
          ),
        ).toMatchObject({ ok: true, hostSessionId: targetSessionId });
        expect(host.store.get("session", targetSessionId).workspaceId).toBe(
          workspaceB,
        );
        expect(host.store.get("session", targetSessionId).workspaceId).not.toBe(
          workspaceA,
        );
        const beforeRestart = [...host.children.values()];
        for (const child of beforeRestart) child.forceStop();
        await Promise.all(beforeRestart.map((child) => child.exited));
        await host.close();
        host = await startHost(hostOptions);
        expect(await resumeReceipt(host, targetSessionId)).toMatchObject({
          status: "rejected",
        });
      } finally {
        const remaining = [...host.children.values()];
        for (const child of remaining) child.forceStop();
        await Promise.all(remaining.map((child) => child.exited));
        await host.close();
      }
    },
  );
});
