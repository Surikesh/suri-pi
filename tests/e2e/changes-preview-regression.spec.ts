import { test, expect } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { browserHost } from "../support/browser-host.js";
import type { Block } from "../../packages/protocol/src/index.js";
const exec = promisify(execFile);

test("hover is inert; click pins and context menu offers preview and review", async ({
  page,
}) => {
  const fixture = await browserHost();
  try {
    await exec("/usr/bin/git", ["-C", fixture.workspace, "init"]);
    await writeFile(
      join(fixture.workspace, "alpha.ts"),
      "export const alpha = 1;\n",
    );
    await writeFile(
      join(fixture.workspace, "beta.ts"),
      "export const beta = 2;\n",
    );
    await page.setViewportSize({ width: 1440, height: 900 });
    await fixture.login(page);
    await expect(
      page.getByRole("textbox", { name: "Message Pi" }),
    ).toBeEnabled();
    const blocks: Block[] = [];
    for (const path of ["alpha.ts", "beta.ts"]) {
      const callId = crypto.randomUUID();
      fixture.host.publish(`session:${fixture.session.id}`, "tool.state", {
        callId,
        name: "write",
        phase: "completed",
        arguments: { path: join(fixture.workspace, path) },
        blocks: [],
      });
      blocks.push({
        id: crypto.randomUUID(),
        kind: "toolCall",
        callId,
        name: "write",
        arguments: { path: join(fixture.workspace, path) },
      });
    }
    blocks.push({
      id: crypto.randomUUID(),
      kind: "text",
      text: "Updated both files.",
    });
    fixture.host.publish(`session:${fixture.session.id}`, "message.upsert", {
      messageId: crypto.randomUUID(),
      role: "assistant",
      revision: 1,
      final: true,
      blocks,
    });
    const alpha = page
      .getByLabel("Files changed")
      .getByRole("button", { name: "alpha.ts", exact: true });
    const beta = page
      .getByLabel("Files changed")
      .getByRole("button", { name: "beta.ts", exact: true });
    const panel = page.getByRole("complementary", {
      name: "Workspace details",
    });
    await alpha.hover();
    await page.waitForTimeout(400);
    await expect(panel).toBeHidden();
    // Dismissing a menu restores focus without implicitly opening review.
    for (const dismissal of ["escape", "outside"] as const) {
      await alpha.click({ button: "right" });
      const closedMenu = page.getByRole("menu", {
        name: "Actions for alpha.ts",
      });
      await expect(closedMenu).toBeVisible();
      if (dismissal === "escape") await page.keyboard.press("Escape");
      else await page.mouse.click(700, 65);
      await expect(closedMenu).toBeHidden();
      await expect(alpha).toBeFocused();
      await page.waitForTimeout(400);
      await expect(panel).toBeHidden();
    }
    // A pointer-induced focus must not open/reflow the panel before click.
    await alpha.click();
    await expect(panel.getByLabel("Changes in alpha.ts")).toBeVisible();
    await expect(
      panel.getByRole("button", { name: "Pin preview" }),
    ).toHaveCount(0);
    await page.mouse.move(700, 65);
    await page.waitForTimeout(700);
    await expect(panel.getByLabel("Changes in alpha.ts")).toBeVisible();
    await beta.hover();
    await page.waitForTimeout(400);
    await expect(panel.getByLabel("Changes in alpha.ts")).toBeVisible();
    await beta.click({ button: "right" });
    const betaMenu = page.getByRole("menu", { name: "Actions for beta.ts" });
    await betaMenu
      .getByRole("menuitem", { name: "Preview", exact: true })
      .click();
    const preview = page.getByRole("dialog", { name: "Preview beta.ts" });
    await expect(preview).toBeVisible();
    await expect
      .poll(() => preview.locator(".file-line span[style]").count())
      .toBeGreaterThan(0);
    await preview.getByRole("button", { name: "Close" }).click();
    await beta.click({ button: "right" });
    await page
      .getByRole("menu", { name: "Actions for beta.ts" })
      .getByRole("menuitem", { name: "Review changes", exact: true })
      .click();
    await expect(panel.getByLabel("Changes in beta.ts")).toBeVisible();
    await alpha.click({ button: "right" });
    const menu = page.getByRole("menu", { name: "Actions for alpha.ts" });
    await expect(menu).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(menu).toBeHidden();
    await expect(alpha).toBeFocused();
    await page.waitForTimeout(400);
    await expect(panel.getByLabel("Changes in beta.ts")).toBeVisible();
  } finally {
    await fixture.close();
  }
});
