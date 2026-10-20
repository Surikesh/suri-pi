import { test, expect } from "@playwright/test";
import { browserHost } from "../support/browser-host.js";

const prefix = "PI_SUBAGENT_ASYNC_JSON:";
const widget = (state: "running" | "failed") =>
  prefix +
  JSON.stringify({
    kind: "pi-subagents.async-status-snapshot",
    version: 1,
    generatedAt: 1,
    caps: { maxRuns: 20 },
    omitted: { runs: 0, children: 0, byteLimitExceeded: false },
    runs: [
      {
        id: "synthetic-run",
        kind: "workflow",
        label: "worker",
        state,
        children: [
          {
            id: "implement",
            kind: "step",
            label: "Implement vertical slice",
            state,
            activity: { turnCount: 6, toolCount: 20 },
          },
        ],
      },
    ],
  });

test("subagent status is legible and scoped instead of exposing widget JSON", async ({
  page,
}, testInfo) => {
  const fixture = await browserHost();
  const stream = `session:${fixture.session.id}`;
  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    await fixture.login(page);
    fixture.host.publish(stream, "extension.widget", {
      key: "subagent-async",
      lines: [widget("running")],
    });
    fixture.host.publish(stream, "extension.widget", {
      key: "subagent-inspect",
      lines: ['PI_SUBAGENT_INSPECT_JSON:{"private":true}'],
    });
    const region = page.getByRole("region", { name: "Subagent activity" });
    await expect(region).toContainText("Subagents");
    await expect(region).toContainText("1 running");
    await expect(region).toContainText("Implement vertical slice");
    await expect(region).toContainText("6 turns · 20 tools");
    await expect(page.getByText("PI_SUBAGENT_ASYNC_JSON:")).toHaveCount(0);
    await expect(page.getByText("PI_SUBAGENT_INSPECT_JSON:")).toHaveCount(0);
    await page.screenshot({
      path: testInfo.outputPath("subagents-desktop.png"),
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(region).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath("subagents-narrow.png"),
    });
    fixture.host.publish(stream, "extension.widget", {
      key: "subagent-async",
      lines: [widget("failed")],
    });
    await expect(region).toContainText("Failed");
    fixture.host.publish(stream, "extension.widget", {
      key: "subagent-async",
      lines: [],
    });
    await expect(region).toHaveCount(0);
    fixture.host.publish(stream, "extension.widget", {
      key: "subagent-async",
      lines: [prefix + "{"],
    });
    await expect(page.getByText("Subagent status unavailable")).toBeVisible();
    await expect(page.getByText(prefix, { exact: false })).toHaveCount(0);
  } finally {
    await fixture.close();
  }
});
