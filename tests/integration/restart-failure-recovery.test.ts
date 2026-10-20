import { expect, test } from "vitest";
import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { restartFixture } from "../support/restart-fixture.js";
import { updateDiagnostics } from "../../apps/host/src/update-diagnostics.js";

// Real isolated worker/launcher failure after old-host drain; no provider or personal profile.
test("post-drain import failure has offline evidence and explicit retained recovery without retry", async () => {
  const fixture = await restartFixture();
  try {
    const session = await fixture.seed();
    const client = await fixture.client();
    const before = await client("updates.get");
    const beforeOrigin = (await fixture.bootstrap()).origin;
    const target = await fixture.candidate(true);
    const available = await client("updates.get");
    expect(available.available.host.buildId).toBe(target);
    const cli = join(
      fixture.data,
      "host-builds",
      fixture.initial.hostBuildId,
      "dist/apps/host/src/cli.js",
    );
    const env = {
      ...process.env,
      SURI_DATA_DIR: fixture.data,
      SURI_SIMULATED: "1",
      SURI_VALIDATE: "1",
    };
    await promisify(execFile)(
      process.execPath,
      [
        cli,
        "updates",
        "restart",
        target,
        String(available.available.host.generation),
        "--confirm",
      ],
      { cwd: fixture.data, env, timeout: 10000 },
    );
    let report: any;
    await expect
      .poll(
        async () => {
          const approval = JSON.parse(
            await readFile(join(fixture.data, "updates/restart.json"), "utf8"),
          );
          report = await readFile(
            join(fixture.data, "run", `restart-${approval.operationId}.json`),
            "utf8",
          )
            .then(JSON.parse)
            .catch(() => null);
          return report?.code;
        },
        { timeout: 20000 },
      )
      .toBe("HOST_TARGET_START_FAILED");
    expect(report).toMatchObject({
      oldHostState: "stopped",
      targetBuildId: target,
      retryable: false,
      action: "inspect-diagnostics",
    });
    const diagnostics = await updateDiagnostics(fixture.data);
    expect(diagnostics.launch).toMatchObject({
      status: "OBSERVED",
      code: "HOST_MODULE_EVALUATION_FAILED",
      failedStage: "module-import",
    });
    expect(JSON.stringify(diagnostics)).not.toContain(
      "FIXTURE_TARGET_IMPORT_FAILURE",
    );
    await expect(fixture.health()).rejects.toThrow();
    await promisify(execFile)(
      process.execPath,
      [
        cli,
        "updates",
        "start-retained",
        fixture.initial.hostBuildId,
        before.ui.activeId,
        "--confirm",
      ],
      { cwd: fixture.data, env, timeout: 20000 },
    );
    const recovered = await fixture.health();
    expect(recovered.hostBuildId).toBe(fixture.initial.hostBuildId);
    expect(recovered.instanceId).not.toBe(fixture.initial.instanceId);
    expect((await fixture.bootstrap()).origin).toBe(beforeOrigin);
    const restoredClient = await fixture.client();
    const after = await restoredClient("updates.get");
    expect(
      (await restoredClient("catalog.get")).sessions.map(
        (item: { id: string }) => item.id,
      ),
    ).toContain(session.id);
    expect(after.profileId).toBe(before.profileId);
    expect(after.restart.approval.phase).toBe("cancelled");
    expect(after.restart.approval.code).toBe("HOST_INSTANCE_CHANGED");
  } finally {
    // Keep an offline failed fixture for diagnosis; never mask its original assertion.
    if (
      await fixture.health().then(
        () => true,
        () => false,
      )
    )
      await fixture.close();
  }
}, 45000);
