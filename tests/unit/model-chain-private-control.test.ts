import { afterEach, describe, expect, it } from "vitest";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import type { Duplex } from "node:stream";
import { randomUUID } from "node:crypto";
import { PiClient } from "../../packages/pi-adapter/src/index.js";
import { DurableChain } from "../../packages/model-chain/src/index.js";
import {
  createBrokerHandshake,
  destroyBrokerKey,
  signBrokerFrame,
  verifyBrokerFrame,
} from "../../packages/model-chain/src/broker-framing.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("Model Chain private host broker", () => {
  it("single-flights concurrent descriptor factories across separate loader instances", async () => {
    const root = await mkdtemp(join(tmpdir(), "suri-chain-loader-"));
    roots.push(root);
    const runner = join(root, "runner.mjs");
    const adapters = pathToFileURL(
      resolve("packages/model-chain/src/fd-broker.ts"),
    ).href;
    await writeFile(
      runner,
      `
const [a,b]=await Promise.all([import(${JSON.stringify(adapters + "?loader=a")}),import(${JSON.stringify(adapters + "?loader=b")})]);
try { await Promise.all([a.consumeFdBrokerHandshake(),b.consumeFdBrokerHandshake()]); process.stdout.write('READY'); setInterval(()=>{},1000); }
catch(error) { process.stdout.write('ERROR:'+error.message); process.exit(2); }
`,
    );
    const child = spawn(process.execPath, ["--import", "tsx", runner], {
      stdio: ["ignore", "pipe", "pipe", "pipe"],
    });
    const control = child.stdio[3] as Duplex | null;
    if (!control) throw new Error("missing control pipe");
    const broker = createBrokerHandshake(randomUUID());
    control.write(`${JSON.stringify(broker.handshake)}\n`);
    const output = await new Promise<string>((resolveOutput, reject) => {
      const timer = setTimeout(
        () => reject(new Error("loader probe timed out")),
        3000,
      );
      child.stdout!.once("data", (chunk) => {
        clearTimeout(timer);
        resolveOutput(chunk.toString());
      });
      child.once("exit", (code) => {
        if (code) {
          clearTimeout(timer);
          reject(new Error(`loader exited ${code}`));
        }
      });
    });
    expect(output).toBe("READY");
    child.kill("SIGTERM");
    await new Promise((done) => child.once("exit", done));
    destroyBrokerKey(broker.key);
  });

  // Needs a provisioned Pi runtime under .runtime (not part of this repository).
  it.skipIf(!existsSync(resolve(".runtime/pi-0.85.1")))(
    "single-flights ownership through the pinned Pi real extension loader",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "suri-chain-real-loader-"));
      roots.push(root);
      const broker = createBrokerHandshake(randomUUID());
      const child = spawn(
        resolve(".runtime/node/node-v24.15.0-darwin-arm64/bin/node"),
        [
          resolve(
            ".runtime/pi-0.85.1/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js",
          ),
          "--mode",
          "rpc",
          "--no-session",
          "--no-extensions",
          "--no-skills",
          "--no-prompt-templates",
          "-e",
          resolve(".pi/extensions/model-chain.ts"),
          "-e",
          resolve("packages/pi-adapter/src/review-queue-extension.ts"),
        ],
        {
          cwd: root,
          env: {
            PATH: process.env.PATH,
            HOME: root,
            PI_CODING_AGENT_DIR: join(root, "agent"),
          },
          stdio: ["pipe", "pipe", "pipe", "pipe"],
        },
      );
      const control = child.stdio[3] as Duplex | null;
      if (!control) throw new Error("missing control pipe");
      let brokerInput = "";
      let brokerCounter = 0;
      control.on("data", (chunk) => {
        brokerInput += chunk.toString();
        while (brokerInput.includes("\n")) {
          const index = brokerInput.indexOf("\n");
          const line = brokerInput.slice(0, index);
          brokerInput = brokerInput.slice(index + 1);
          if (!line) continue;
          verifyBrokerFrame(
            broker.key,
            broker.handshake.channelId,
            brokerCounter + 1,
            line,
          );
          brokerCounter += 1;
          control.write(
            `${JSON.stringify(
              signBrokerFrame(
                broker.key,
                broker.handshake.channelId,
                brokerCounter,
                { ok: true, role: "implementer" },
              ),
            )}\n`,
          );
        }
      });
      control.write(`${JSON.stringify(broker.handshake)}\n`);
      child.stdin!.write('{"id":"ready","type":"get_state"}\n');
      const response = await new Promise<any>((resolveResponse, reject) => {
        let output = "";
        const timer = setTimeout(
          () => reject(new Error("real loader readiness timed out")),
          5000,
        );
        child.stdout!.on("data", (chunk) => {
          output += chunk.toString();
          for (const line of output.split("\n").filter(Boolean)) {
            try {
              const value = JSON.parse(line);
              if (value.id === "ready") {
                clearTimeout(timer);
                resolveResponse(value);
                return;
              }
            } catch {}
          }
        });
        child.once("exit", (code) => {
          clearTimeout(timer);
          reject(new Error(`real loader exited ${code}`));
        });
      });
      expect(response).toMatchObject({ id: "ready", success: true });
      child.kill("SIGTERM");
      await new Promise((done) => child.once("exit", done));
      destroyBrokerKey(broker.key);
    },
    10_000,
  );

  it.each(["{bad json}\n", `${"x".repeat(1100)}\n`])(
    "closes its owned socket after invalid or oversized handshake",
    async (input) => {
      const root = await mkdtemp(join(tmpdir(), "suri-chain-invalid-"));
      roots.push(root);
      const runner = join(root, "runner.mjs");
      const adapters = pathToFileURL(
        resolve("packages/model-chain/src/adapters.ts"),
      ).href;
      await writeFile(
        runner,
        `import {consumeFdBrokerHandshake} from ${JSON.stringify(adapters)}; try { await consumeFdBrokerHandshake(); process.exit(3) } catch(error) { process.stdout.write(error.message); }`,
      );
      const child = spawn(process.execPath, ["--import", "tsx", runner], {
        stdio: ["ignore", "pipe", "pipe", "pipe"],
      });
      const control = child.stdio[3] as Duplex | null;
      if (!control) throw new Error("missing control pipe");
      control.write(input);
      const output = await new Promise<string>((resolveOutput) =>
        child.stdout!.once("data", (chunk) => resolveOutput(chunk.toString())),
      );
      const exit = await new Promise<number | null>((done) =>
        child.once("exit", done),
      );
      expect(output).toBe("SURI_CHAIN_CAPABILITY_INVALID");
      expect(exit).toBe(0);
      expect(control.destroyed).toBe(true);
    },
  );

  it("rejects a forged nested-tool frame even when fd 3 is deliberately inherited", async () => {
    const root = await mkdtemp(join(tmpdir(), "suri-chain-control-"));
    roots.push(root);
    const executable = join(root, "fake-pi.mjs");
    await writeFile(
      executable,
      `#!/usr/bin/env node
import fs from 'node:fs';
import { createHmac } from 'node:crypto';
import { spawnSync } from 'node:child_process';
let control='';
const reader=fs.createReadStream(null,{fd:3,autoClose:false});
reader.on('data',b=>{control+=b; const i=control.indexOf('\\n'); if(i<0)return; reader.pause(); const h=JSON.parse(control.slice(0,i));
  spawnSync(process.execPath,['-e',"const fs=require('fs');fs.writeSync(3,JSON.stringify({v:1,channelId:'forged',counter:1,payload:{mutate:true},mac:'bad'})+'\\\\n')"],{stdio:['ignore','pipe','pipe',3]});
  const payload={probe:true,env:Object.keys(process.env).filter(k=>k.includes('BROKER')||k.includes('CAPABILITY')),argv:process.argv.filter(v=>v.includes('capability'))};
  const canonical=JSON.stringify([1,h.channelId,1,payload]);
  const mac=createHmac('sha256',Buffer.from(h.key,'base64url')).update(canonical).digest('base64url');
  fs.writeSync(3,JSON.stringify({v:1,channelId:h.channelId,counter:1,payload,mac})+'\\n');
});
let input=''; process.stdin.on('data',b=>{input+=b; while(input.includes('\\n')){const i=input.indexOf('\\n'); const line=input.slice(0,i); input=input.slice(i+1); if(!line)continue; const request=JSON.parse(line); process.stdout.write(JSON.stringify({type:'response',id:request.id,command:request.type,success:true,data:{sessionFile:'/tmp/fake.jsonl'}})+'\\n');}}); process.stdin.on('end',()=>process.exit(0));
`,
      { mode: 0o700 },
    );
    await chmod(executable, 0o700);
    const broker = createBrokerHandshake(randomUUID());
    let expectedCounter = 0;
    const observed: unknown[] = [];
    const pi = new PiClient(
      {
        executable,
        cwd: root,
        sessionDir: root,
        privateControl: {
          handshake: JSON.stringify(broker.handshake),
          handle: async (raw) => {
            try {
              const packet = verifyBrokerFrame(
                broker.key,
                broker.handshake.channelId,
                expectedCounter + 1,
                raw,
              );
              expectedCounter += 1;
              observed.push(packet);
              return JSON.stringify(
                signBrokerFrame(
                  broker.key,
                  broker.handshake.channelId,
                  expectedCounter,
                  { ok: true },
                ),
              );
            } catch {
              return undefined;
            }
          },
        },
      },
      () => {},
    );
    await pi.request("get_state");
    for (let i = 0; i < 50 && observed.length === 0; i++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    expect(observed).toEqual([{ probe: true, env: [], argv: [] }]);
    pi.forceStop();
    await pi.exited;
  });

  it.each(["malformed", "forged", "replayed"])(
    "terminally closes a real fd channel on %s responses",
    async (mode) => {
      const root = await mkdtemp(
        join(tmpdir(), "suri-chain-invalid-response-"),
      );
      roots.push(root);
      const runner = join(root, "runner.mjs");
      const adapters = pathToFileURL(
        resolve("packages/model-chain/src/adapters.ts"),
      ).href;
      await writeFile(
        runner,
        `import {consumeFdBrokerHandshake,takeStartupBrokerTransport} from ${JSON.stringify(adapters)};
await consumeFdBrokerHandshake();
const transport=takeStartupBrokerTransport();
const settled=await Promise.allSettled([transport({request:1}),transport({request:2})]);
let later='fulfilled';try{await transport({request:3})}catch(error){later=error.message}
process.stdout.write(JSON.stringify({settled:settled.map(item=>item.status==='rejected'?item.reason.message:item.status),later}));`,
      );
      const child = spawn(process.execPath, ["--import", "tsx", runner], {
        stdio: ["ignore", "pipe", "pipe", "pipe"],
      });
      const control = child.stdio[3] as Duplex | null;
      if (!control) throw new Error("missing control pipe");
      const broker = createBrokerHandshake(randomUUID());
      control.write(`${JSON.stringify(broker.handshake)}\n`);
      let requests = "";
      await new Promise<void>((resolveRequests) => {
        control.on("data", (chunk) => {
          requests += chunk.toString();
          if (requests.split("\n").filter(Boolean).length < 2) return;
          control.removeAllListeners("data");
          if (mode === "malformed") control.write("{bad json}\n");
          else if (mode === "forged")
            control.write(
              `${JSON.stringify({ v: 1, channelId: broker.handshake.channelId, counter: 1, payload: {}, mac: "bad" })}\n`,
            );
          else {
            const frame = signBrokerFrame(
              broker.key,
              broker.handshake.channelId,
              1,
              { ok: true },
            );
            control.write(
              `${JSON.stringify(frame)}\n${JSON.stringify(frame)}\n`,
            );
          }
          resolveRequests();
        });
      });
      const output = await new Promise<string>((resolveOutput, reject) => {
        let value = "";
        child.stdout!.on("data", (chunk) => (value += chunk.toString()));
        child.once("exit", (code) =>
          code === 0
            ? resolveOutput(value)
            : reject(new Error(`response probe exited ${code}`)),
        );
      });
      const result = JSON.parse(output);
      expect(result.later).toBe("SURI_CHAIN_CAPABILITY_UNAVAILABLE");
      if (mode === "replayed")
        expect(result.settled).toEqual([
          "fulfilled",
          "SURI_CHAIN_CAPABILITY_INVALID",
        ]);
      else
        expect(result.settled).toEqual([
          "SURI_CHAIN_CAPABILITY_INVALID",
          "SURI_CHAIN_CAPABILITY_INVALID",
        ]);
      expect(control.destroyed).toBe(true);
      destroyBrokerKey(broker.key);
    },
  );

  it("journals a Suri runner failure that occurs before step", async () => {
    const root = await mkdtemp(join(tmpdir(), "suri-chain-runner-"));
    const workspace = await mkdtemp(join(tmpdir(), "suri-chain-workspace-"));
    roots.push(root, workspace);
    const requestId = randomUUID();
    const chain = new DurableChain(root);
    await chain.create({
      schemaVersion: 1,
      requestId,
      taskId: "runner-fixture",
      goal: "Prove startup feedback",
      workspace,
      adapter: "suri",
      stages: [
        {
          id: "probe",
          dependencies: [],
          provider: "openai-codex",
          modelId: "gpt-5.6-luna",
          thinking: "low",
          instruction: "No provider call",
          ownedPaths: [],
          acceptance: ["blocked before dispatch"],
        },
      ],
    });
    const exit = await new Promise<number>((done) => {
      const child = spawn(
        resolve("node_modules/.bin/tsx"),
        [resolve("packages/model-chain/src/runner.ts"), root, requestId],
        { stdio: "ignore" },
      );
      child.once("exit", (code) => done(code ?? -1));
    });
    expect(exit).toBe(3);
    const state = await chain.read(requestId);
    expect(state.status).toBe("blocked");
    expect(state.diagnostic?.code).toBe("SURI_CHAIN_CAPABILITY_UNAVAILABLE");
  });
});
