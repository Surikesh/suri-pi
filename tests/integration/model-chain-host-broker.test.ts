import { afterEach, describe, expect, it } from "vitest";
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { startHost } from "../../apps/host/src/host.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("authenticated Model Chain host authorization", () => {
  it("registers one exact stage and creates/submits one exact visible worker", async () => {
    const root = await mkdtemp(join(tmpdir(), "suri-chain-host-"));
    roots.push(root);
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    const executable = join(root, "fake-pi.mjs");
    await writeFile(
      executable,
      `#!/usr/bin/env node
import fs from 'node:fs'; import path from 'node:path'; import {createHash,createHmac,randomUUID} from 'node:crypto';
const errorFile=path.join(path.dirname(new URL(import.meta.url).pathname),'broker-error');
const sessionDir=process.argv[process.argv.indexOf('--session-dir')+1], source=path.basename(sessionDir)==='source', sessionFile=path.join(sessionDir,'fixture.jsonl'), piSessionId=randomUUID();
let model={provider:'openai-codex',id:'initial'}, thinkingLevel='low', stdin='';
process.stdin.on('end',()=>process.exit(0));process.stdin.on('data',b=>{stdin+=b;while(stdin.includes('\\n')){const i=stdin.indexOf('\\n'),line=stdin.slice(0,i);stdin=stdin.slice(i+1);if(!line)continue;const q=JSON.parse(line);let data={};if(q.type==='get_state')data={sessionId:piSessionId,sessionFile,model,thinkingLevel};if(q.type==='set_model'){model={provider:q.provider,id:q.modelId};data={};}if(q.type==='set_thinking_level'){thinkingLevel=q.level;data={};}process.stdout.write(JSON.stringify({type:'response',id:q.id,command:q.type,success:true,data})+'\\n');}});
if(source){let buf='',key,channel,requestCounter=0,responseCounter=0,pending=[];const stream=fs.createReadStream(null,{fd:3,autoClose:false});
const mac=(counter,payload)=>createHmac('sha256',key).update(JSON.stringify([1,channel,counter,payload])).digest('base64url');
const send=payload=>new Promise(resolve=>{pending.push(resolve);const counter=++requestCounter;fs.writeSync(3,JSON.stringify({v:1,channelId:channel,counter,payload,mac:mac(counter,payload)})+'\\n');});
stream.on('data',async b=>{buf+=b;while(buf.includes('\\n')){const i=buf.indexOf('\\n'),line=buf.slice(0,i);buf=buf.slice(i+1);if(!key){const h=JSON.parse(line);key=Buffer.from(h.key,'base64url');channel=h.channelId;fs.writeSync(3,JSON.stringify({v:1,channelId:'forged',counter:1,payload:{type:'session.create'},mac:'bad'})+'\\n');void run().catch(e=>fs.writeFileSync(errorFile,String(e?.stack||e)));continue;}const f=JSON.parse(line);if(f.counter!==++responseCounter||f.mac!==mac(f.counter,f.payload))process.exit(9);pending.shift()?.(f.payload);}});
async function run(){const requestId=randomUUID(),stageId='canary',attemptId=randomUUID(),targetSessionId=randomUUID();const base={protocol:'suri-model-chain-v1',requestId,stageId,workspace:${JSON.stringify(workspace)},runtimeId:'',commandId:randomUUID()};const host=await send({...base,type:'host.get',payload:{}});base.runtimeId=host.chainContext.runtimeId;const prompt='Chain request '+requestId+'; stage '+stageId+'; attempt '+attemptId+'; session '+targetSessionId+'.\\nSynthetic host integration.\\nFinish with exact result.';const promptHash=createHash('sha256').update(prompt).digest('hex');let r=await send({...base,commandId:randomUUID(),type:'stage.register',payload:{attemptId,targetSessionId,provider:'openai-codex',modelId:'gpt-5.6-luna',thinking:'low',promptHash,expiresAt:Date.now()+60000,commandSequence:['session.create','model.set','thinking.set','run.submit']}});if(!r.ok)throw Error('register '+r.code);const registrationId=r.registrationId;r=await send({...base,registrationId,commandId:randomUUID(),type:'session.create',payload:{name:'Chain fixture'}});if(!r.ok||!r.receipt?.result)throw Error('create '+(r.code||r.receipt?.error?.code||r.receipt?.status));let revision=r.receipt.result.revision;const wrong=await send({...base,registrationId,commandId:randomUUID(),type:'model.set',sessionId:targetSessionId,expectedRevision:revision,payload:{provider:'openai-codex',id:'alternate-model'}});if(wrong.ok)throw Error('alternate model admitted');r=await send({...base,registrationId,commandId:randomUUID(),type:'model.set',sessionId:targetSessionId,expectedRevision:revision,payload:{provider:'openai-codex',id:'gpt-5.6-luna'}});if(!r.ok||!r.receipt?.result)throw Error('model '+(r.code||r.receipt?.error?.code||r.receipt?.status));revision=r.receipt.result.revision;r=await send({...base,registrationId,commandId:randomUUID(),type:'thinking.set',sessionId:targetSessionId,expectedRevision:revision,payload:{level:'low'}});if(!r.ok)throw Error('thinking '+r.code);r=await send({...base,registrationId,commandId:randomUUID(),type:'run.submit',sessionId:targetSessionId,payload:{mode:'prompt',text:prompt,attachmentIds:[]}});if(!r.ok)throw Error('submit '+r.code);const duplicate=await send({...base,registrationId,commandId:randomUUID(),type:'run.submit',sessionId:targetSessionId,payload:{mode:'prompt',text:prompt,attachmentIds:[]}});if(duplicate.ok)throw Error('duplicate submit admitted');}
}
`,
      { mode: 0o700 },
    );
    await chmod(executable, 0o700);
    const host = await startHost({
      root: join(root, "data"),
      assets: resolve("dist/ui"),
      helper: resolve("dist/native/suri-helper"),
      simulated: true,
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
      for (let i = 0; i < 100 && host.store.list("session").length < 2; i++)
        await new Promise((resolve) => setTimeout(resolve, 20));
      const sessions = host.store.list("session");
      expect(sessions).toHaveLength(2);
      const worker = sessions.find((session) => session.id !== "source")!;
      for (
        let i = 0;
        i < 100 && !host.store.get("session", worker.id).hasConversation;
        i++
      )
        await new Promise((resolve) => setTimeout(resolve, 20));
      const brokerError = await readFile(
        join(root, "broker-error"),
        "utf8",
      ).catch(() => "");
      expect(brokerError).toBe("");
      expect(host.store.get("session", worker.id)).toMatchObject({
        model: { provider: "openai-codex", id: "gpt-5.6-luna" },
        thinkingLevel: "low",
        hasConversation: true,
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
      await new Promise((resolve) => setTimeout(resolve, 50));
    } finally {
      await host.close();
    }
  });
});
