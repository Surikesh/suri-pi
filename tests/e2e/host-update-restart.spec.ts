import { test, expect } from "@playwright/test";
import { readFile, rename, mkdir, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join, resolve } from "node:path";
import { restartFixture } from "../support/restart-fixture.js";
import { updateDiagnostics } from "../../apps/host/src/update-diagnostics.js";
// Handoff/nonce material must never be recorded in browser traces.
test.use({ trace: "off" });
test("retained adapter update waits for fake Pi then replaces exact host and reauthenticates two existing tabs", async ({
  browser,
}) => {
  test.setTimeout(60000);
  const fixture = await restartFixture();
  const context = await browser.newContext();
  try {
    const session = await fixture.seed();
    await context.addInitScript((id) => {
      if (!localStorage.getItem("suri.selected"))
        localStorage.setItem("suri.selected", id);
    }, session.id);
    const first = await context.newPage(),
      second = await context.newPage();
    const failures: string[] = [];
    for (const page of [first, second])
      page.on("response", (response) => {
        if (response.url().endsWith("/v1/commands"))
          void response
            .json()
            .then((receipt) => {
              if (receipt.status === "rejected")
                failures.push(
                  `${response.request().postDataJSON().type}:${receipt.error?.code}`,
                );
            })
            .catch(() => {});
      });
    const bootstrap = await fixture.bootstrap();
    await context.request.post(bootstrap.origin + "/v1/bootstrap", {
      headers: { Origin: bootstrap.origin },
      data: { nonce: bootstrap.nonce },
    });
    await first.goto(bootstrap.origin);
    await second.goto(bootstrap.origin);
    for (const page of [first, second])
      await expect
        .poll(() => page.evaluate(() => window.suriUpdate?.ready))
        .toBe(true);
    const editorA = first.getByRole("textbox", { name: "Message Pi" });
    const editorB = second.getByRole("textbox", { name: "Message Pi" });
    await editorA.fill("HOLD retained restart fixture");
    await first
      .getByRole("button", { name: "Send message", exact: true })
      .click();
    await expect(
      first.getByRole("button", { name: "Stop run", exact: true }),
    ).toBeVisible();
    await editorA.fill("Window A unsent draft");
    await editorB.fill("Window B independent draft");
    const target = await fixture.candidate();
    await first
      .getByRole("button", { name: "Host update ready", exact: true })
      .click();
    await first
      .getByRole("button", { name: "Restart when idle", exact: true })
      .click();
    await first
      .getByRole("button", { name: "Approve restart", exact: true })
      .click();
    await expect(
      first.getByRole("button", {
        name: "Will restart when work finishes",
        exact: true,
      }),
    ).toBeVisible();
    expect((await fixture.health()).instanceId).toBe(
      fixture.initial.instanceId,
    );
    expect((await fixture.health()).activeWork).toBeGreaterThan(0);
    await first.getByRole("button", { name: "Close updates" }).click();
    await first.getByRole("button", { name: "Stop run", exact: true }).click();
    await expect
      .poll(
        async () => {
          try {
            return (await fixture.health()).hostBuildId;
          } catch {
            return null;
          }
        },
        { timeout: 40000 },
      )
      .toBe(target);
    const newInstance = (await fixture.health()).instanceId;
    for (const page of [first, second]) {
      await expect
        .poll(
          () =>
            page
              .evaluate(() => window.suriUpdate?.descriptor.hostInstanceId)
              .catch(() => null),
          { timeout: 15000 },
        )
        .toBe(newInstance);
      await expect
        .poll(
          () =>
            page.evaluate(() => window.suriUpdate?.ready).catch(() => false),
          { timeout: 15000 },
        )
        .toBe(true);
    }
    await expect(editorA).toHaveValue("Window A unsent draft");
    await expect(editorB).toHaveValue("Window B independent draft");
    expect(context.pages()).toHaveLength(2);
    const replacement = await fixture.health();
    expect(replacement.instanceId).not.toBe(fixture.initial.instanceId);
    expect(replacement.pid).not.toBe(fixture.initial.pid);
    expect((await fixture.bootstrap()).origin).toBe(bootstrap.origin);
    await expect
      .poll(async () => (await updateDiagnostics(fixture.data)).restart.code)
      .toBe("VERIFIED");
    const calls = (
      await readFile(join(fixture.checkout, "rpc-calls.jsonl"), "utf8")
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(calls.filter((call) => call.type === "prompt")).toHaveLength(1);
    // Old CSRF is intentionally invalid while the approved handoff rotates it.
    const identityStatus = await first.evaluate(() =>
      window.suriUpdate!.command("updates.get"),
    );
    const loadedUiIds = await Promise.all(
      [first, second].map((page) =>
        page.evaluate(() => window.suriUpdate!.descriptor.buildId),
      ),
    );
    expect(loadedUiIds).toEqual([
      identityStatus.ui.activeId,
      identityStatus.ui.activeId,
    ]);
    expect(identityStatus.runningHost.epoch).toEqual(expect.any(String));
    await mkdir(resolve(".suri-local/diagnostics"), { recursive: true });
    await writeFile(
      resolve(
        `.suri-local/diagnostics/modern-update-identities-${test.info().project.name}.json`,
      ),
      JSON.stringify(
        {
          evidence: "retained-process-fake-pi",
          browser: test.info().project.name,
          loadedUiIds,
          activeUiId: identityStatus.ui.activeId,
          runningHostBuildId: identityStatus.runningHost.buildId,
          availableHostBuildId: identityStatus.available.host.buildId ?? null,
          hostInstanceId: replacement.instanceId,
          hostEpoch: identityStatus.runningHost.epoch,
          profileId: identityStatus.profileId,
          origin: bootstrap.origin,
          shellId: null,
          nativeAcceptance: "not-run",
        },
        null,
        2,
      ),
    );
    await first.setViewportSize({ width: 1440, height: 900 });
    await first
      .getByRole("button", { name: "Up to date", exact: true })
      .click();
    await first.screenshot({
      path: resolve(".suri-local/diagnostics/modern-host-restarted.png"),
    });
    await first
      .getByRole("button", { name: "Close updates", exact: true })
      .click();
    expect(
      // Read/lease polling can overlap shared-cookie rotation; draft writes cannot.
      // Model prefetch may resume a session right as the restarted host reports
      // it busy with the held run; the runtime is already active, so BUSY is benign.
      failures.filter(
        (code) =>
          ![
            "updates.get:UNAUTHORIZED",
            "updates.client:UNAUTHORIZED",
            "session.resume:BUSY",
          ].includes(code),
      ),
    ).toEqual([]);
    await rename(fixture.checkout, fixture.checkout + "-unavailable");
    await expect(
      first.getByRole("button", {
        name: "Development source unavailable",
        exact: true,
      }),
    ).toBeVisible();
    await fixture.stop();
    const launch = await promisify(execFile)(
      process.execPath,
      [
        join(fixture.data, "host-builds", target, "dist/apps/host/src/cli.js"),
        "open",
        "--no-open",
      ],
      {
        cwd: fixture.data,
        env: {
          ...process.env,
          SURI_DATA_DIR: fixture.data,
          SURI_SIMULATED: "1",
          SURI_VALIDATE: "1",
        },
        timeout: 20000,
      },
    );
    expect(JSON.parse(launch.stdout).origin).toBe(bootstrap.origin);
    expect((await fixture.health()).hostBuildId).toBe(target);
    const reopened = await fixture.bootstrap();
    await context.request.post(reopened.origin + "/v1/bootstrap", {
      headers: { Origin: reopened.origin },
      data: { nonce: reopened.nonce },
    });
    await first.goto(reopened.origin + "/app");
    await expect
      .poll(() => first.evaluate(() => window.suriUpdate?.ready))
      .toBe(true);
    await expect(editorA).toHaveValue("Window A unsent draft");
    expect(context.pages()).toHaveLength(2);
    await fixture.stop();
    const offline = await promisify(execFile)(
      process.execPath,
      [
        join(fixture.data, "host-builds", target, "dist/apps/host/src/cli.js"),
        "updates",
        "diagnostics",
      ],
      {
        cwd: fixture.data,
        env: { ...process.env, SURI_DATA_DIR: fixture.data },
        timeout: 5000,
      },
    );
    expect(JSON.parse(offline.stdout).source).toBe("persisted-not-live");
    expect(JSON.parse(offline.stdout).launch.status).toBe("OBSERVED");
    expect(JSON.parse(offline.stdout).restart.status).toBe("OBSERVED");
    const recoveredHost = await promisify(execFile)(
      process.execPath,
      [
        join(fixture.data, "host-builds", target, "dist/apps/host/src/cli.js"),
        "updates",
        "recover-host",
        "--previous",
      ],
      {
        cwd: fixture.data,
        env: {
          ...process.env,
          SURI_DATA_DIR: fixture.data,
          SURI_SIMULATED: "1",
          SURI_VALIDATE: "1",
        },
        timeout: 20000,
      },
    );
    expect(JSON.parse(recoveredHost.stdout)).toEqual({
      recovered: true,
      origin: bootstrap.origin,
    });
    expect((await fixture.health()).hostBuildId).toBe(
      fixture.initial.hostBuildId,
    );
    const restoredCatalog = await (await fixture.client())("catalog.get");
    expect(
      restoredCatalog.sessions.some(
        (item: { id: string }) => item.id === session.id,
      ),
    ).toBe(true);
  } catch (error) {
    const command = await fixture.client().catch(() => null);
    const status = command
      ? await command("updates.get").catch(() => null)
      : null;
    const execution = await updateDiagnostics(fixture.data);
    await test.info().attach("bounded-restart-state", {
      body: JSON.stringify({
        restart: status?.restart,
        runningHost: status?.runningHost,
        clients: status?.clients,
        execution,
      }),
      contentType: "application/json",
    });
    throw error;
  } finally {
    await context.close();
    await fixture.close();
  }
});
