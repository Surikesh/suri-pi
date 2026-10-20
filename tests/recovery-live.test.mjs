// Isolated real host + PTY acceptance. Never touches the personal profile.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { control } from "../dist/apps/host/src/cli.js";
const exec = promisify(execFile);

test(
  "recovery closes an explicitly authorized owned PTY and restarts isolated host",
  { skip: process.platform !== "darwin", timeout: 60000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "suri-recovery-"));
    const data = join(root, "data");
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    const env = { ...process.env, SURI_DATA_DIR: data, SHELL: "/bin/zsh" };
    const cli = (...args) =>
      exec(process.execPath, [resolve("dist/apps/host/src/cli.js"), ...args], {
        env,
        timeout: 30000,
      });
    let closeFixture = async () => {};
    try {
      await cli("open", "--no-open");
      const before = await control(data, { type: "health" });
      const bootstrap = await control(data, { type: "bootstrap" });
      const response = await fetch(bootstrap.origin + "/v1/bootstrap", {
        method: "POST",
        headers: {
          Origin: bootstrap.origin,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ nonce: bootstrap.nonce }),
      });
      const auth = await response.json();
      const headers = {
        Origin: bootstrap.origin,
        "Content-Type": "application/json",
        Cookie: response.headers.get("set-cookie").split(";")[0],
        "X-Suri-Csrf": auth.csrf,
      };
      const command = async (type, payload) => {
        const receipt = await (
          await fetch(bootstrap.origin + "/v1/commands", {
            method: "POST",
            headers,
            body: JSON.stringify({
              v: 1,
              id: randomUUID(),
              createdAt: new Date().toISOString(),
              type,
              payload,
            }),
          })
        ).json();
        assert.equal(receipt.status, "completed", receipt.error?.code);
        return receipt.result;
      };
      closeFixture = () =>
        command("host.shutdown", {
          expectedInstanceId: before.instanceId,
          closeTerminals: true,
        });
      const grant = await control(data, {
        type: "grant",
        kind: "directory",
        path: workspace,
      });
      await command("project.add", { directoryGrantId: grant.grantId });
      const catalog = await command("catalog.get", {});
      const workspaceId = catalog.workspaces[0].id;
      await command("terminal.create", { workspaceId, cols: 80, rows: 24 });
      await new Promise((r) => setTimeout(r, 500));
      const run = (...args) =>
        exec(process.execPath, [resolve("scripts/recover.mjs"), ...args], {
          env,
          timeout: 30000,
        });
      const report = JSON.parse((await run()).stdout);
      assert.equal(report.action, "diagnosed-no-changes");
      assert.equal(report.cwd, "durable-data-root");
      assert.equal(report.terminalCandidates.length, 1);
      assert.equal(report.activeWork, 1);
      await assert.rejects(run("--restart", "--no-open"), (error) => {
        assert.equal(error.code, 2);
        assert.equal(JSON.parse(error.stdout).action, "blocked-active-work");
        return true;
      });
      assert.equal(
        (await control(data, { type: "health" })).instanceId,
        before.instanceId,
      );
      const recovered = JSON.parse(
        (await run("--restart", "--close-idle-terminals", "--no-open")).stdout,
      );
      assert.equal(recovered.action, "restarted-no-client");
      assert.notEqual(recovered.newInstanceId, before.instanceId);
      const after = await control(data, { type: "health" });
      assert.equal(after.activeWork, 0);
      const fresh = await control(data, { type: "bootstrap" });
      assert.equal(fresh.origin, bootstrap.origin);
    } finally {
      await closeFixture().catch(() => {});
      await cli("shutdown").catch(() => {});
      let running = true;
      for (let i = 0; i < 50; i++) {
        running = await control(data, { type: "health" }).then(
          () => true,
          () => false,
        );
        if (!running) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      if (running)
        throw Error("Fixture host still running; private profile retained.");
      await rm(root, { recursive: true, force: true });
    }
  },
);
