import { expect, it } from "vitest";
import { chmod, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { browserHost } from "../support/browser-host.js";
import { control } from "../../apps/host/src/cli.js";

it("latches startup failure across observations and retries only explicitly", async () => {
  const fixture = await browserHost();
  try {
    const executable = join(fixture.root, "fake-pi", "dist", "cli.mjs");
    const counter = join(fixture.root, "spawn-count");
    await writeFile(
      executable,
      `#!/usr/bin/env node
import fs from 'node:fs';
const file=${JSON.stringify(counter)};
let count=0;try{count=Number(fs.readFileSync(file,'utf8'))||0}catch{}
fs.writeFileSync(file,String(count+1));
process.stderr.write('extension factory failed synthetic-secret');
setTimeout(()=>process.exit(1),150);
`,
      { mode: 0o755 },
    );

    await fixture.execute("session.resume", {}, fixture.session.id);
    await expect
      .poll(async () => {
        const health = await control(fixture.data, { type: "health" });
        return health.work.blockers.find(
          (item: any) => item.kind === "sessions-or-rpc",
        )?.owners?.[0];
      })
      .toMatchObject({
        owner: fixture.session.id,
        attempt: expect.any(String),
        categories: expect.arrayContaining(["boot"]),
      });
    await expect
      .poll(
        () =>
          fixture.host.store.snapshot(`session:${fixture.session.id}`).phase,
        { timeout: 5_000 },
      )
      .toBe("failed");
    expect(await readFile(counter, "utf8")).toBe("1");

    for (let index = 0; index < 20; index++) {
      await fixture.execute("session.context", {}, fixture.session.id);
      await fixture
        .execute("commands.list", {}, fixture.session.id)
        .catch(() => undefined);
      await fixture
        .execute("model.list", {}, fixture.session.id)
        .catch(() => undefined);
    }
    expect(await readFile(counter, "utf8")).toBe("1");

    await fixture.execute("session.resume", {}, fixture.session.id);
    await expect
      .poll(async () => Number(await readFile(counter, "utf8")))
      .toBe(2);
    await expect
      .poll(
        () =>
          fixture.host.store.snapshot(`session:${fixture.session.id}`).phase,
        { timeout: 5_000 },
      )
      .toBe("failed");
    expect(fixture.host.children.size).toBe(0);
    expect(
      JSON.stringify(
        fixture.host.store.snapshot(`session:${fixture.session.id}`),
      ),
    ).not.toContain("synthetic-secret");
  } finally {
    await fixture.close();
  }
});

it("releases a private-control spawn failure and allows an explicit repaired retry", async () => {
  const fixture = await browserHost(undefined, undefined, false);
  try {
    const executable = join(fixture.root, "fake-pi", "dist", "cli.mjs");
    fixture.host.store.put("runtime", {
      ...fixture.host.store.get("runtime", fixture.runtime.id),
      status: "verified",
    });
    await chmod(executable, 0o644);

    await fixture.execute("session.resume", {}, fixture.session.id);
    await expect
      .poll(
        () =>
          fixture.host.store.snapshot(`session:${fixture.session.id}`).phase,
        { timeout: 5_000 },
      )
      .toBe("failed");
    await expect.poll(() => fixture.host.children.size).toBe(0);
    await expect
      .poll(
        async () =>
          (await control(fixture.data, { type: "health" })).activeWork,
      )
      .toBe(0);
    expect(
      fixture.host.store.get("session", fixture.session.id).processPid,
    ).toBeUndefined();
    expect(
      fixture.host.store.snapshot(`session:${fixture.session.id}`).phase,
    ).toBe("failed");

    await chmod(executable, 0o755);
    await fixture.execute("session.resume", {}, fixture.session.id);
    await expect
      .poll(
        () =>
          fixture.host.store.snapshot(`session:${fixture.session.id}`).phase,
        { timeout: 5_000 },
      )
      .toBe("idle");
    expect(fixture.host.children.size).toBe(1);
    expect(
      fixture.host.store.get("session", fixture.session.id).processPid,
    ).toEqual(expect.any(Number));
  } finally {
    await fixture.close();
  }
});

it("owns a failed non-exiting startup until bounded retirement, then retries successfully", async () => {
  const fixture = await browserHost();
  try {
    const executable = join(fixture.root, "fake-pi", "dist", "cli.mjs");
    const counter = join(fixture.root, "retirement-spawn-count");
    await writeFile(
      executable,
      `#!/usr/bin/env node
import fs from 'node:fs';
const file=${JSON.stringify(counter)};
let count=0;try{count=Number(fs.readFileSync(file,'utf8'))||0}catch{}
count += 1; fs.writeFileSync(file,String(count));
let input='';
process.stdin.on('data',chunk=>{input+=chunk;while(input.includes('\\n')){const i=input.indexOf('\\n');const q=JSON.parse(input.slice(0,i));input=input.slice(i+1);if(q.type==='get_state')process.stdout.write(JSON.stringify({type:'response',id:q.id,command:q.type,success:true,data:{model:{provider:'fixture',id:count===1?'other':'target'}}})+'\\n');else if(q.type==='set_model')process.stdout.write(JSON.stringify({type:'response',id:q.id,command:q.type,success:false,error:'rejected'})+'\\n');}});
process.stdin.on('end',()=>{if(count>1)process.exit(0)});
process.on('SIGTERM',()=>setTimeout(()=>process.exit(0),100));
setInterval(()=>{},1000);
`,
      { mode: 0o755 },
    );
    fixture.host.store.put("session", {
      ...fixture.host.store.get("session", fixture.session.id),
      model: { provider: "fixture", id: "target" },
    });

    await fixture.execute("session.resume", {}, fixture.session.id);
    await expect
      .poll(
        () =>
          fixture.host.store.snapshot(`session:${fixture.session.id}`).phase,
        { timeout: 5_000 },
      )
      .toBe("failed");
    expect(fixture.host.children.has(fixture.session.id)).toBe(true);
    const duringCleanup = await control(fixture.data, { type: "health" });
    expect(duringCleanup.activeWork).toBeGreaterThan(0);
    expect(duringCleanup.work.blockers).toContainEqual(
      expect.objectContaining({
        kind: "sessions-or-rpc",
        owners: expect.arrayContaining([
          expect.objectContaining({
            owner: fixture.session.id,
            categories: expect.arrayContaining(["retirement"]),
          }),
        ]),
      }),
    );
    expect(
      fixture.host.store.snapshot(`session:${fixture.session.id}`).phase,
    ).toBe("failed");
    await expect
      .poll(() => fixture.host.children.has(fixture.session.id))
      .toBe(false);
    await expect
      .poll(
        async () =>
          (await control(fixture.data, { type: "health" })).activeWork,
      )
      .toBe(0);
    expect(
      fixture.host.store.snapshot(`session:${fixture.session.id}`).phase,
    ).toBe("failed");

    await fixture.execute("session.resume", {}, fixture.session.id);
    await expect
      .poll(
        () =>
          fixture.host.store.snapshot(`session:${fixture.session.id}`).phase,
        { timeout: 5_000 },
      )
      .toBe("idle");
    expect(await readFile(counter, "utf8")).toBe("2");
  } finally {
    await fixture.close();
  }
});
