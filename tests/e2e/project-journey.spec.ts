import { test, expect } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { browserHost, modelDiscovery } from "../support/browser-host.js";

for (const width of [1440, 760, 390])
  test(`folder clicks to session and complete menus at ${width}`, async ({
    page,
  }, info) => {
    const fixture = await browserHost();
    try {
      const project = join(fixture.workspace, "Garden");
      await mkdir(project);
      await writeFile(join(project, "hello.txt"), "first line\nsecond line\n");
      await fixture.login(page);
      await page.setViewportSize({ width, height: 900 });
      const navigation = async () => {
        if (
          width < 900 &&
          !(await page.locator(".sidebar").getAttribute("class"))?.includes(
            "open",
          )
        )
          await page.getByRole("button", { name: "Open navigation" }).click();
      };
      await navigation();
      const trigger = page.getByRole("button", {
        name: "Add project",
        exact: true,
      });
      await trigger.click();
      const dialog = page.getByRole("dialog", {
        name: "Add project",
        exact: true,
      });
      await expect(
        dialog.getByRole("button", { name: "Go", exact: true }),
      ).toBeEnabled();
      await expect(
        dialog.locator(".directory-list button").first(),
      ).toBeVisible();
      await expect(
        dialog.locator(".directory-list .directory-folder-icon").first(),
      ).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(trigger).toBeFocused();
      await trigger.press("Enter");
      // The host's home is a disposable fixture. The entire user journey
      // navigates folders by clicking; no typed paths or local-control grants.
      await dialog.getByRole("button", { name: "Garden" }).click();
      await expect(dialog.locator(".directory-selection")).toContainText(
        "Garden",
      );
      await page.screenshot({ path: info.outputPath("folder-picker.png") });
      const discovered = modelDiscovery(page);
      await dialog
        .getByRole("button", { name: "Open folder", exact: true })
        .click();
      await expect(dialog).toHaveCount(0);
      const editor = page.getByRole("textbox", { name: "Message Pi" });
      // Registration selects a new draft in the chosen workspace, not the old session.
      await expect(page.locator("header")).toContainText("Garden");
      await expect(editor).toBeEnabled();
      // The new session resumes for model discovery; wait before submitting so
      // the prompt is not delivered as a queued follow-up.
      await discovered;
      await expect(page.locator(".run-status")).toContainText("idle");
      await editor.fill("Grow a synthetic garden");
      await editor.press("Enter");
      await expect(
        page.getByRole("button", { name: "Open hello.txt:2", exact: true }),
      ).toBeVisible();
      await navigation();
      await page
        .getByRole("button", { name: "View options", exact: true })
        .click();
      const options = page.locator(".view-options");
      const unreadFilter = options.getByRole("menuitemcheckbox", {
        name: "Unread",
        exact: true,
      });
      const textStart = (element: Element) => {
        const range = document.createRange();
        range.selectNodeContents(element);
        return range.getBoundingClientRect().x;
      };
      const manualTextX = await options
        .getByRole("menuitemradio", { name: "Manual", exact: true })
        .evaluate(textStart);
      const unreadTextX = await unreadFilter.evaluate(textStart);
      expect(Math.abs(unreadTextX - manualTextX)).toBeLessThan(0.1);
      await expect(unreadFilter).toHaveAttribute("aria-checked", "false");
      await expect(unreadFilter).toHaveCSS("color", "rgb(98, 107, 120)");
      await expect(unreadFilter).toHaveCSS("font-weight", "400");
      await unreadFilter.click();
      await expect(unreadFilter).toHaveAttribute("aria-checked", "true");
      await expect(unreadFilter).toHaveCSS("color", "rgb(32, 35, 41)");
      await expect(unreadFilter).toHaveCSS("font-weight", "600");
      await unreadFilter.click();
      await expect(unreadFilter).toHaveAttribute("aria-checked", "false");
      await expect(page.locator(".section-heading").first()).toHaveCSS(
        "justify-content",
        "flex-start",
      );
      await page.screenshot({
        path: info.outputPath("navigation-options.png"),
      });
      await page.keyboard.press("Escape");
      await page
        .getByRole("button", {
          name: "Actions for project Garden",
          exact: true,
        })
        .click();
      const projectMenu = page.getByRole("menu", {
        name: "Actions for project Garden",
        exact: true,
      });
      for (const name of [
        "Rename project / workspaces…",
        "Add workspace…",
        "Change icon…",
        "Pin project",
        "Copy project path",
        "Remove from Suri…",
      ])
        await expect(
          projectMenu.getByRole("menuitem", { name, exact: true }),
        ).toBeVisible();
      await page.screenshot({ path: info.outputPath("project-menu.png") });
      await page.keyboard.press("Escape");
      const row = page.getByRole("button", {
        name: "Grow a synthetic garden",
        exact: true,
      });
      await row.click({ button: "right" });
      const menu = page.getByRole("menu", {
        name: "Actions for Grow a synthetic garden",
        exact: true,
      });
      const menuNames = [
        "Pin",
        "Mark as unread",
        "Highlight",
        "Copy project path",
        "Copy session ID",
        "Copy session link",
        "Rename",
        "Fork session",
        "Clone session",
        "Archive",
      ];
      for (const name of menuNames)
        await expect(
          menu.getByRole("menuitem", { name, exact: true }),
        ).toBeVisible();
      await expect(
        menu.getByRole("menuitem", { name: /Reveal in Finder/ }),
      ).toBeDisabled();
      const bounds = await menu.boundingBox();
      expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(900);
      await page.screenshot({ path: info.outputPath("session-menu.png") });
      await menu
        .getByRole("menuitem", { name: "Highlight", exact: true })
        .click();
      await row.click({ button: "right" });
      await expect(
        menu.getByRole("menuitem", { name: "Remove highlight", exact: true }),
      ).toBeVisible();
      await page.keyboard.press("Escape");
      await fixture.restart(page);
      await expect(page.locator("header")).toContainText("Garden");
      await navigation();
      await row.click({ button: "right" });
      await expect(
        menu.getByRole("menuitem", { name: "Remove highlight", exact: true }),
      ).toBeVisible();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
    } finally {
      await fixture.close();
    }
  });
