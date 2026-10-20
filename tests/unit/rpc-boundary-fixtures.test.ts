import { it, expect } from "vitest";
import { mkdtemp, writeFile, readFile, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PiClient } from "../../packages/pi-adapter/src/index.js";
import { importHeader } from "../../apps/host/src/import-header.js";
for (const version of (
  process.env.SURI_FIXTURE_VERSIONS ?? "0.84.4,0.85.1"
).split(",")) {
  const root = join("tests/fixtures/pi", version);
  for (const file of (await readdir(root)).filter((f) =>
    f.endsWith(".expected.json"),
  )) {
    const metadata = JSON.parse(await readFile(join(root, file), "utf8"));
    if (!["client", "header"].includes(metadata.driver)) continue;
    it(`Pi ${version} ${metadata.id} uses real boundary code`, async () => {
      const fixture = resolve(root, file.replace(".expected.json", ".jsonl"));
      if (metadata.driver === "header") {
        await expect(
          importHeader(await readFile(fixture), process.cwd()),
        ).rejects.toThrow("match the selected workspace");
        return;
      }
      const dir = await mkdtemp(join(tmpdir(), "suri-rpc-boundary-"));
      const executable = join(dir, "rpc-fixture.mjs");
      await writeFile(
        executable,
        `#!/usr/bin/env node
import {readFileSync,appendFileSync} from 'node:fs';import {createInterface} from 'node:readline';
const records=readFileSync(${JSON.stringify(fixture)},'utf8').trim().split('\\n').map(JSON.parse);
createInterface({input:process.stdin}).on('line',line=>{const input=JSON.parse(line);appendFileSync(${JSON.stringify(join(dir, "commands.jsonl"))},JSON.stringify(input)+'\\n');const record=records.find(r=>r.command===input.type);if(record?.type==='fixture_exit')process.exit(0);if(record)process.stdout.write(JSON.stringify({...record,id:input.id})+'\\n');});
`,
        { mode: 0o755 },
      );
      const pi = new PiClient(
        { executable, cwd: dir, sessionDir: dir },
        () => {},
      );
      try {
        switch (metadata.expected.scenario) {
          case "models": {
            const models = await pi.models();
            expect(models.models[0].id).toBe("fixture");
            expect(JSON.stringify(models)).not.toContain("synthetic-secret");
            break;
          }
          case "settings": {
            for (const type of [
              "set_auto_compaction",
              "set_auto_retry",
              "set_steering_mode",
              "set_follow_up_mode",
            ])
              await expect(pi.request(type)).rejects.toThrow(
                "Global settings writes",
              );
            await pi.request("get_state");
            const sent = await readFile(join(dir, "commands.jsonl"), "utf8");
            expect(sent.trim().split("\n")).toHaveLength(1);
            expect(sent).toContain("get_state");
            break;
          }
          case "fork":
            expect((await pi.request("fork")).cancelled).toBe(true);
            expect((await pi.request("get_state")).sessionId).toBe("fixture");
            break;
          case "empty":
            expect((await pi.request("get_state")).sessionFile).toBeNull();
            expect((await pi.request("get_messages")).messages).toEqual([]);
            expect(
              (await readdir(dir)).filter((f) => f.endsWith(".jsonl")),
            ).toEqual(["commands.jsonl"]);
            break;
          case "exit":
            await expect(pi.request("get_state")).rejects.toThrow(
              /Pi startup failed \(unknown, rpc-readiness; attempt [0-9a-f-]{36}\)\./,
            );
            break;
          default:
            throw Error("Unknown fixture scenario");
        }
      } finally {
        pi.close();
        await new Promise((r) => setTimeout(r, 30));
        await rm(dir, { recursive: true, force: true });
      }
    });
  }
}
