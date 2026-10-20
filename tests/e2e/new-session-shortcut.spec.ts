import { test, expect } from "@playwright/test";
import { mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { control } from "../../apps/host/src/cli.js";
import { browserHost } from "../support/browser-host.js";

for (const width of [1440, 760]) {
  test(`Control Alt N chooses the project for a new session at ${width}`, async ({
    page,
  }) => {
    const fixture = await browserHost();
    try {
      const secondRoot = join(fixture.root, "Another project");
      await mkdir(secondRoot);
      const secondPath = await realpath(secondRoot);
      const grant = await control(fixture.data, {
        type: "grant",
        kind: "directory",
        path: secondPath,
      });
      const secondProject = await fixture.execute("project.add", {
        directoryGrantId: grant.grantId,
      });
      const secondWorkspace = fixture.host.store
        .list("workspace")
        .find((item) => item.projectId === secondProject.id)!;

      await page.setViewportSize({ width, height: 900 });
      await fixture.login(page);
      await expect(page.getByRole("status")).toContainText("Connected");
      const before = fixture.host.store.list("session").length;

      await page.keyboard.press("Control+Alt+KeyN");
      const dialog = page.getByRole("dialog", { name: "New session" });
      await expect(dialog).toBeVisible();
      const projectInput = dialog.getByRole("combobox", {
        name: "Project for new session",
      });
      await expect(projectInput).toHaveValue(fixture.project.label);
      await expect(projectInput).toBeFocused();

      await projectInput.fill("Another");
      await expect(
        dialog.getByRole("option", { name: /Another project/ }),
      ).toBeVisible();
      await page.keyboard.press("Enter");
      await expect(dialog).toBeHidden();
      await expect
        .poll(() => fixture.host.store.list("session").length)
        .toBe(before + 1);
      const created = fixture.host.store
        .list("session")
        .find((item) => item.workspaceId === secondWorkspace.id)!;
      expect(created.workspaceId).toBe(secondWorkspace.id);
      await expect
        .poll(() => page.evaluate(() => localStorage.getItem("suri.selected")))
        .toBe(created.id);

      const editor = page.getByRole("textbox", {
        name: "Message Pi",
        exact: true,
      });
      await expect(editor).toBeFocused();
      await page.keyboard.type("Shortcut draft");
      await expect(editor).toHaveValue("Shortcut draft");

      if (width < 900)
        await page
          .getByRole("button", { name: "Open navigation", exact: true })
          .click();
      const newSessionButton = page.getByRole("button", {
        name: "New session ⌃⌥N",
        exact: true,
      });
      await newSessionButton.click();
      await expect(dialog).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(newSessionButton).toBeFocused();
      await newSessionButton.click();
      await expect(projectInput).toHaveValue("Another project");
      await dialog.getByRole("button", { name: "Create session" }).click();
      await expect
        .poll(() => fixture.host.store.list("session").length)
        .toBe(before + 2);
      await expect(editor).toBeFocused();
      await expect(editor).toHaveValue("");
      await page.keyboard.type("Button draft");
      await expect(editor).toHaveValue("Button draft");
    } finally {
      await fixture.close();
    }
  });
}
