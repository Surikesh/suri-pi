import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { restartFixture } from "../support/restart-fixture.js";

test.use({ trace: "off" });

test("committed handoff with a lost response is recovered as durable success", async ({
  browser,
}) => {
  test.setTimeout(60000);
  process.env.SURI_TEST_DROP_HANDOFF_COMMIT_RESPONSE = "1";
  const fixture = await restartFixture();
  const context = await browser.newContext();
  try {
    const bootstrap = await fixture.bootstrap();
    await context.request.post(bootstrap.origin + "/v1/bootstrap", {
      headers: { Origin: bootstrap.origin },
      data: { nonce: bootstrap.nonce },
    });
    const page = await context.newPage();
    const nativeLifecycle: string[] = [];
    await page.exposeFunction(
      "recordNativeLifecycle",
      (message: { type?: string; state?: string }) => {
        if (message.type === "hostLifecycle" && message.state)
          nativeLifecycle.push(message.state);
      },
    );
    await page.addInitScript(() => {
      (window as any).webkit = {
        messageHandlers: {
          suri: {
            postMessage: (message: unknown) =>
              (window as any).recordNativeLifecycle(message),
          },
        },
      };
    });
    await page.goto(bootstrap.origin + "/?shell=2");
    await expect
      .poll(() => page.evaluate(() => window.suriUpdate?.ready))
      .toBe(true);
    await fixture.candidate();
    await page
      .getByRole("button", { name: "Host update ready", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Restart host", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Approve restart", exact: true })
      .click();
    let approval: any;
    await expect
      .poll(
        async () => {
          approval = await readFile(
            join(fixture.data, "updates/restart.json"),
            "utf8",
          )
            .then(JSON.parse)
            .catch(() => null);
          if (!approval) return null;
          const report = await readFile(
            join(fixture.data, "run", `restart-${approval.operationId}.json`),
            "utf8",
          )
            .then(JSON.parse)
            .catch(() => null);
          return report?.code;
        },
        { timeout: 40000 },
      )
      .toBe("VERIFIED");
    await expect
      .poll(() => page.evaluate(() => window.suriUpdate?.ready), {
        timeout: 40000,
      })
      .toBe(true);
    await expect
      .poll(async () =>
        readFile(join(fixture.data, "updates/restart.json"), "utf8")
          .then(JSON.parse)
          .then((value) => value.phase)
          .catch(() => null),
      )
      .toBe("completed");
    await expect
      .poll(() => nativeLifecycle.includes("restartInProgress"))
      .toBe(true);
    await expect
      .poll(() => nativeLifecycle.includes("reconnecting"))
      .toBe(true);
    const state = await readFile(
      join(fixture.data, "run/restart-handoffs.json"),
      "utf8",
    ).then(JSON.parse);
    const replacement = await fixture.health();
    expect(state.handoffs).toEqual([]);
    expect(state.commits).toContainEqual(
      expect.objectContaining({
        operationId: approval.operationId,
        targetBuildId: approval.targetBuildId,
        toInstanceId: replacement.instanceId,
      }),
    );
  } finally {
    delete process.env.SURI_TEST_DROP_HANDOFF_COMMIT_RESPONSE;
    await context.close();
    if (
      await fixture.health().then(
        () => true,
        () => false,
      )
    )
      await fixture.close();
  }
});
