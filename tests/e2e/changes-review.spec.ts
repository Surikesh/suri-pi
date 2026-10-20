import { test, expect } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { browserHost } from "../support/browser-host.js";
const exec = promisify(execFile);

for (const width of [1440, 760, 390])
  test(`current review interaction and race at ${width}`, async ({
    page,
  }, info) => {
    const fixture = await browserHost();
    try {
      const git = (...args: string[]) =>
        exec("/usr/bin/git", ["-C", fixture.workspace, ...args]);
      await git("init");
      await writeFile(
        join(fixture.workspace, "app.ts"),
        'export const title = "Before";\nconst stable = true;\n',
      );
      await git("add", ".");
      await git(
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "commit",
        "-m",
        "fixture baseline",
      );
      await writeFile(
        join(fixture.workspace, "app.ts"),
        'export const title = "Staged";\nconst stable = true;\n',
      );
      await git("add", "app.ts");
      await writeFile(
        join(fixture.workspace, "app.ts"),
        'export const title = "Current";\nconst stable = true;\nexport const description = "' +
          "Long readable source ".repeat(20) +
          '";\n',
      );
      await writeFile(
        join(fixture.workspace, "hello.txt"),
        "The current working tree\n",
      );
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      await fixture.login(page);
      const editor = page.getByRole("textbox", { name: "Message Pi" });
      await expect(editor).toBeEnabled();
      for (const path of [
        "app.ts",
        "hello.txt",
        "historical.ts",
        "failed.ts",
      ]) {
        const callId = crypto.randomUUID();
        fixture.host.publish(`session:${fixture.session.id}`, "tool.state", {
          callId,
          name: "edit",
          phase: path === "failed.ts" ? "failed" : "completed",
          arguments: { path },
          blocks: [],
        });
        fixture.host.publish(
          `session:${fixture.session.id}`,
          "message.upsert",
          {
            messageId: crypto.randomUUID(),
            role: "assistant",
            revision: 1,
            final: true,
            blocks: [
              {
                id: crypto.randomUUID(),
                kind: "toolCall",
                callId,
                name: "edit",
                arguments: { path },
              },
              {
                id: crypto.randomUUID(),
                kind: "text",
                text:
                  path === "failed.ts" ? "Edit failed." : `Reviewed ${path}.`,
              },
            ],
          },
        );
      }
      const links = page.locator(".message-file-link");
      await expect(links).toHaveCount(3);
      const app = links.filter({ hasText: "app.ts" });
      const hello = links.filter({ hasText: "hello.txt" });
      const old = links.filter({ hasText: "historical.ts" });
      const details = page.getByRole("complementary", {
        name: "Workspace details",
      });
      if (width === 1440) {
        await app.hover();
        await page.waitForTimeout(400);
        await expect(details).toBeHidden();
        await app.focus();
        await expect(details).toBeHidden();
        await editor.focus();
        // Focusing a changed-file link must preserve the existing Files pane.
        await page
          .getByRole("button", { name: "Open workspace details" })
          .click();
        await details
          .getByRole("treeitem", { name: "hello.txt", exact: true })
          .click();
        await app.focus();
        await expect(
          details.getByRole("tab", { name: "Files", exact: true }),
        ).toHaveAttribute("aria-selected", "true");
        await expect(details.getByLabel("Preview hello.txt")).toBeVisible();
      } else {
        await app.hover();
        await app.focus();
        await expect(details).toBeHidden();
      }
      await app.focus();
      await page.keyboard.press("Enter");
      await expect(
        details.getByText("Current workspace changes", { exact: true }),
      ).toHaveCount(0);
      await expect(
        details.getByText(
          "Not a response snapshot. Refresh for the latest Git state.",
        ),
      ).toHaveCount(0);
      await expect(
        details.getByRole("button", { name: "Pin preview" }),
      ).toHaveCount(0);
      const patch = details.getByLabel("Changes in app.ts", { exact: true });
      await expect(patch).toContainText('"Current"');
      await expect(
        patch.getByRole("heading", { name: "Staged · HEAD → index" }),
      ).toBeVisible();
      await expect(
        patch.getByRole("heading", { name: "Unstaged · index → working tree" }),
      ).toBeVisible();
      await expect(patch).not.toContainText("diff --git");
      await expect(patch).not.toContainText("@@");
      await expect(patch.locator(".diff-number").first()).toHaveText("1");
      await expect
        .poll(() => patch.locator("code span[style]").count())
        .toBeGreaterThan(0);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await page.screenshot({
        path: info.outputPath(`review-${width}.png`),
      });
      if (width === 1440) {
        await hello.hover();
        await page.waitForTimeout(400);
        await expect(patch).toContainText('"Current"');
        await hello.focus();
        await expect(hello).toBeFocused();
        await expect(patch).toContainText('"Current"');
        // Hold an old response until after a newer selection has completed.
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
          release = resolve;
        });
        const held = new Set<boolean>();
        await page.route("**/v1/commands", async (route) => {
          const body = route.request().postDataJSON();
          if (body.type === "git.diff" && body.payload.path === "hello.txt") {
            const response = await route.fetch();
            held.add(body.payload.staged);
            await gate;
            await route.fulfill({ response });
          } else await route.continue();
        });
        await hello.click();
        await expect.poll(() => held.size).toBe(2);
        await app.click();
        await expect(patch).toContainText('"Current"');
        release();
        await page.unrouteAll({ behavior: "wait" });
        await page.evaluate(
          () =>
            new Promise((resolve) =>
              requestAnimationFrame(() => requestAnimationFrame(resolve)),
            ),
        );
        await expect(patch).toContainText('"Current"');
        await expect(patch).not.toContainText("current working tree");
        await old.click();
      } else {
        await details.getByRole("button", { name: "Close details" }).click();
        await old.click();
      }
      await expect(
        details.getByText("No current diff for this file", { exact: true }),
      ).toBeVisible();
      await expect(
        details.getByText(/Historical snapshots are not stored/),
      ).toBeVisible();
      await expect(details.locator(".change-preview-header strong")).toHaveText(
        "historical.ts",
      );
    } finally {
      await fixture.close();
    }
  });
