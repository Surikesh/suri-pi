import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { browserHost } from "../support/browser-host.js";

const stream = (sessionId: string) => `session:${sessionId}`;

function publishPartialActivity(
  host: Awaited<ReturnType<typeof browserHost>>["host"],
  sessionId: string,
  label: string,
) {
  const messageId = `${label}-message`;
  const callId = `${label}-tool`;
  host.publish(stream(sessionId), "message.upsert", {
    messageId,
    role: "assistant",
    revision: 1,
    final: false,
    blocks: [
      { id: `${label}-text`, kind: "text", text: `${label} before reload` },
      {
        id: `${label}-tool-block`,
        kind: "toolCall",
        callId,
        name: `${label}_reload_probe`,
        arguments: { label },
      },
    ],
  });
  host.publish(stream(sessionId), "tool.state", {
    callId,
    messageId,
    name: `${label}_reload_probe`,
    phase: "running",
    arguments: { label },
    blocks: [],
  });
  return { messageId, callId };
}

function finishActivity(
  host: Awaited<ReturnType<typeof browserHost>>["host"],
  sessionId: string,
  label: string,
  ids: { messageId: string; callId: string },
) {
  host.publish(stream(sessionId), "tool.state", {
    callId: ids.callId,
    messageId: ids.messageId,
    name: `${label}_reload_probe`,
    phase: "completed",
    arguments: { label },
    blocks: [
      { id: `${label}-result`, kind: "text", text: `${label} tool completed` },
    ],
  });
  host.publish(stream(sessionId), "message.upsert", {
    messageId: ids.messageId,
    role: "assistant",
    revision: 2,
    final: true,
    blocks: [
      { id: `${label}-text`, kind: "text", text: `${label} after reload` },
      {
        id: `${label}-tool-block`,
        kind: "toolCall",
        callId: ids.callId,
        name: `${label}_reload_probe`,
        arguments: { label },
      },
    ],
  });
}

test("response usage shows tokens, cache and cost without elapsed time", async ({
  page,
}, testInfo) => {
  const fixture = await browserHost();
  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    await fixture.login(page);
    fixture.host.publish(stream(fixture.session.id), "usage.updated", {
      input: 78_100,
      output: 14_000,
      cacheRead: 51_200,
      cacheWrite: 2_400,
      cost: 3.0489,
    });

    const usage = page.locator(
      '.turn-usage[aria-label="Latest response usage"]',
    );
    await expect(usage).toContainText("↑78.1K");
    await expect(usage).toContainText("↓14K");
    await expect(usage).toContainText("Cache read51.2K");
    await expect(usage).toContainText("Cache write2.4K");
    await expect(usage).toContainText("Cost$3.0489");
    await expect(usage).not.toContainText(/\d{1,2}:\d{2}/);
    await expect(page.locator(".usage-footer")).not.toHaveCSS(
      "overflow-x",
      "scroll",
    );
    await page.screenshot({
      path: testInfo.outputPath("response-usage-desktop.png"),
    });
    await page.setViewportSize({ width: 760, height: 900 });
    await expect(usage).toBeVisible();
    await expect(page.locator(".usage-footer")).not.toHaveCSS(
      "overflow-x",
      "scroll",
    );
    await page.screenshot({
      path: testInfo.outputPath("response-usage-narrow.png"),
    });
  } finally {
    await fixture.close();
  }
});

test("informational notice dismissal is event-scoped and preserves drafts and attachments", async ({
  page,
}) => {
  const fixture = await browserHost();
  try {
    await fixture.login(page);
    const sessionId = fixture.session.id;
    await page.getByLabel("Message Pi").fill("kept draft");
    await page.evaluate((id) => {
      localStorage.setItem(
        `suri.attachments.${id}`,
        JSON.stringify([{ id: "attachment-1", name: "kept.txt" }]),
      );
    }, sessionId);
    fixture.host.publish(stream(sessionId), "notice", {
      code: "runtime_recovery",
      severity: "info",
      text: "Runtime recovery updated.",
    });
    fixture.host.publish(stream(sessionId), "notice", {
      code: "queue_cleared",
      severity: "info",
      text: "Cleared queued messages were returned to your draft.",
    });
    await expect(page.locator(".notice.informational")).toHaveCount(2);
    const dismissNotice = page.getByRole("button", {
      name: "Dismiss notification",
    });
    await dismissNotice.first().click();
    await dismissNotice.first().click();
    await expect(page.locator(".notice.informational")).toHaveCount(0);

    await expect(page.locator(".notice.informational")).toHaveCount(0);
    await expect(page.getByLabel("Message Pi")).toHaveValue("kept draft");
    expect(
      await page.evaluate(
        (id) => localStorage.getItem(`suri.attachments.${id}`),
        sessionId,
      ),
    ).toContain("attachment-1");

    fixture.host.publish(stream(sessionId), "notice", {
      code: "runtime_recovery",
      severity: "info",
      text: "Runtime recovery updated again.",
    });
    await expect(page.locator(".notice.informational")).toContainText(
      "Runtime recovery updated again.",
    );
  } finally {
    await fixture.close();
  }
});

test("frontend reload preserves concurrent runs and replays activity without resubmitting prompts", async ({
  page,
}) => {
  const fixture = await browserHost();
  try {
    const second = await fixture.execute("session.create", {
      workspaceId: fixture.workspaceId,
      runtimeId: fixture.runtime.id,
      name: "Reload background fixture",
    });

    await fixture.login(page);
    const editor = page.getByRole("textbox", { name: "Message Pi" });
    await editor.fill("HOLD reload foreground");
    await editor.press("Enter");
    await expect(page.getByRole("button", { name: "Stop run" })).toBeVisible();

    await fixture.execute(
      "run.submit",
      { mode: "prompt", text: "HOLD reload background", attachmentIds: [] },
      second.id,
    );
    await expect
      .poll(() => fixture.host.store.snapshot(stream(second.id)).phase)
      .toBe("running");

    const foreground = publishPartialActivity(
      fixture.host,
      fixture.session.id,
      "foreground",
    );
    const background = publishPartialActivity(
      fixture.host,
      second.id,
      "background",
    );
    await expect(page.getByText("foreground before reload")).toBeVisible();

    await editor.fill("draft survives frontend reload");
    await page.evaluate(() => window.suriFlush?.());

    const reload = page.reload();
    finishActivity(fixture.host, fixture.session.id, "foreground", foreground);
    finishActivity(fixture.host, second.id, "background", background);
    await reload;

    await expect(page.getByRole("status")).toContainText("Connected");
    await expect(page.getByText("foreground after reload")).toBeVisible();
    let activity = page.locator("details.activity-group").filter({
      hasText: "1 tool call",
    });
    await activity.locator(":scope > summary").click();
    await activity.locator("details.tool > summary").click();
    await expect(page.getByText("foreground tool completed")).toBeVisible();
    await expect(editor).toHaveValue("draft survives frontend reload");
    expect(fixture.host.store.snapshot(stream(fixture.session.id)).phase).toBe(
      "running",
    );
    expect(fixture.host.store.snapshot(stream(second.id)).phase).toBe(
      "running",
    );

    await page.evaluate(
      (sessionId) =>
        (
          window as unknown as { suriSelectSession?: (id: string) => void }
        ).suriSelectSession?.(sessionId),
      second.id,
    );
    await expect(page.getByText("background after reload")).toBeVisible();
    activity = page.locator("details.activity-group").filter({
      hasText: "1 tool call",
    });
    await activity.locator(":scope > summary").click();
    await activity.locator("details.tool > summary").click();
    await expect(page.getByText("background tool completed")).toBeVisible();
    await expect(page.getByRole("button", { name: "Stop run" })).toBeVisible();

    const calls = (
      await readFile(join(fixture.workspace, "rpc-calls.jsonl"), "utf8")
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .filter((call) => call.type === "prompt");
    expect(
      calls.filter((call) => call.message === "HOLD reload foreground"),
    ).toHaveLength(1);
    expect(
      calls.filter((call) => call.message === "HOLD reload background"),
    ).toHaveLength(1);
  } finally {
    await fixture.close();
  }
});
