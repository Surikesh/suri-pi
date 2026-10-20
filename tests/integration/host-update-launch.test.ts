import { it, expect } from "vitest";
import { spawnSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { control } from "../../apps/host/src/cli.js";
import {
  mkdtemp,
  readFile,
  rm,
  cp,
  writeFile,
  symlink,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
it("pre-import retained launcher verifies exact executable inventory and rejects changed bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "su-"));
  try {
    const pointer = JSON.parse(
      await readFile(".build/host/latest.json", "utf8"),
    );
    const artifact = join(root, "data/host-builds", pointer.buildId);
    const uiPointer = JSON.parse(
      await readFile(".build/ui/latest.json", "utf8"),
    );
    const manifest = JSON.parse(
      await readFile(
        resolve(".build/host", pointer.buildId, "manifest.json"),
        "utf8",
      ),
    );
    await cp(resolve(".build/host", pointer.buildId), artifact, {
      recursive: true,
    });
    const environment = { ...process.env, SURI_DATA_DIR: join(root, "data") };
    const checked = spawnSync(
      process.execPath,
      [join(artifact, "launch.mjs"), "--check"],
      { env: environment, encoding: "utf8", timeout: 30_000 },
    );
    expect(checked.status, checked.stderr).toBe(0);
    expect(JSON.parse(checked.stdout).buildId).toBe(pointer.buildId);
    expect(
      JSON.parse(
        await readFile(join(root, "data/run/update-launch.json"), "utf8"),
      ),
    ).toMatchObject({
      stage: "preflight",
      code: "VERIFIED",
      targetId: pointer.buildId,
    });
    const child = spawn(
      process.execPath,
      [join(artifact, "launch.mjs"), "serve"],
      {
        env: {
          ...environment,
          SURI_ASSETS_DIR: resolve(".build/ui", uiPointer.buildId),
          SURI_PORT: "0",
        },
        stdio: "ignore",
      },
    );
    const exited = new Promise<void>((done) =>
      child.once("exit", () => done()),
    );
    let health;
    try {
      for (let attempt = 0; attempt < 100; attempt++) {
        if (child.exitCode !== null) break;
        try {
          health = await control(environment.SURI_DATA_DIR, { type: "health" });
          break;
        } catch {
          await new Promise((done) => setTimeout(done, 50));
        }
      }
      expect(health?.hostBuildId).toBe(pointer.buildId);
      expect(health?.instanceId).toMatch(/^[a-f0-9-]{36}$/);
      await symlink(artifact, join(root, "alias"));
      const status = spawnSync(
        process.execPath,
        [join(root, "alias/dist/apps/host/src/cli.js"), "updates", "status"],
        { env: environment, encoding: "utf8", timeout: 10_000 },
      );
      expect(status.status, status.stderr).toBe(0);
      expect(status.stdout.trim(), "CLI_RESULT_MISSING").not.toBe("");
      expect(JSON.parse(status.stdout)).toMatchObject({
        activationSupported: manifest.identity.compatibility.hostMin === 2,
        runningHost: {
          buildId: pointer.buildId,
          instanceId: health.instanceId,
          provenance: "verified-launch",
        },
      });
    } finally {
      if (health) {
        const launch = await control(environment.SURI_DATA_DIR, {
          type: "bootstrap",
        });
        const bootstrap = await fetch(launch.origin + "/v1/bootstrap", {
          method: "POST",
          headers: {
            Origin: launch.origin,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ nonce: launch.nonce }),
        });
        const session = await bootstrap.json();
        const receipt = await fetch(launch.origin + "/v1/commands", {
          method: "POST",
          headers: {
            Origin: launch.origin,
            "Content-Type": "application/json",
            Cookie: bootstrap.headers.get("set-cookie")!.split(";")[0],
            "X-Suri-CSRF": session.csrf,
          },
          body: JSON.stringify({
            v: 1,
            id: randomUUID(),
            type: "host.shutdown",
            createdAt: new Date().toISOString(),
            payload: { expectedInstanceId: health.instanceId },
          }),
        });
        expect((await receipt.json()).status).toBe("completed");
      }
      await exited;
    }
    await rm(join(root, "data/run/endpoint.json"), { force: true });
    const missingEndpoint = spawnSync(
      process.execPath,
      [
        join(artifact, "dist/apps/host/src/cli.js"),
        "updates",
        "start-retained",
        pointer.buildId,
        uiPointer.buildId,
        "--confirm",
      ],
      { env: environment, encoding: "utf8", timeout: 10_000 },
    );
    expect(missingEndpoint.status).toBe(1);
    expect(JSON.parse(missingEndpoint.stderr)).toMatchObject({
      code: "CONTROL_ENDPOINT_MISSING",
    });
    await expect(
      control(environment.SURI_DATA_DIR, { type: "health" }),
    ).rejects.toBeTruthy();
    await writeFile(
      join(artifact, "dist/apps/host/src/host.js"),
      "throw new Error('must never execute');",
    );
    const refused = spawnSync(
      process.execPath,
      [join(artifact, "launch.mjs"), "--check"],
      { env: environment, encoding: "utf8", timeout: 30_000 },
    );
    expect(refused.status).toBe(1);
    expect(JSON.parse(refused.stderr)).toEqual({
      code: "HOST_START_INVENTORY_FAILED",
    });
    expect(refused.stderr).not.toContain("must never execute");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
