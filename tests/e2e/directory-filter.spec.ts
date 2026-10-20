import { test, expect } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { browserHost } from "../support/browser-host.js";

for (const width of [1440, 390])
  test(`folder suggestions follow typing without stale results at ${width}`, async ({
    page,
  }, info) => {
    const fixture = await browserHost();
    let releaseInitial = () => {};
    try {
      for (const name of [
        "AlphaOne",
        "AlphaOnly",
        "Desktop",
        "Developer",
        "Dev2",
        "Dev10",
        "Notes",
        ".Developer",
      ])
        await mkdir(join(fixture.workspace, name));
      await mkdir(join(fixture.workspace, "Developer", "Docs"));
      await mkdir(join(fixture.workspace, "Desktop", "Pictures"));
      await writeFile(join(fixture.workspace, "Device.txt"), "not a directory");
      await fixture.login(page);
      await page.setViewportSize({ width, height: 900 });
      if (width < 900)
        await page.getByRole("button", { name: "Open navigation" }).click();
      await expect(page.getByRole("note")).toContainText("simulated models");
      const initialGate = new Promise<void>((resolve) => {
        releaseInitial = resolve;
      });
      let initial = true;
      await page.route("**/v1/commands", async (route) => {
        const body = route.request().postDataJSON();
        if (initial && body.type === "directory.list" && !body.payload.path) {
          initial = false;
          await initialGate;
        }
        await route.continue();
      });
      // Exercise the keyboard launcher as well as the click journey in project-journey.
      await page
        .getByRole("button", { name: "Add project", exact: true })
        .focus();
      await page
        .getByRole("button", { name: "Add project", exact: true })
        .press("Enter");
      const dialog = page.getByRole("dialog");
      const input = dialog.getByRole("textbox", { name: "Folder path" });
      await expect(input).not.toBeEditable();
      releaseInitial();
      await expect(input).toBeEditable();
      await expect(
        dialog.getByRole("button", { name: "Developer", exact: true }),
      ).toBeVisible();
      const home = await input.inputValue();
      await input.fill(home + "/De");
      const names = dialog.locator(".directory-list button span:nth-child(2)");
      await expect(names).toHaveText(["Desktop", "Dev2", "Dev10", "Developer"]);
      await expect(
        dialog.getByRole("button", { name: "Open folder", exact: true }),
      ).toBeDisabled();
      await page.screenshot({ path: info.outputPath("filtered-folders.png") });
      await input.press("Tab");
      await expect(input).toHaveValue(home + "/De");
      await expect(
        dialog.getByRole("button", { name: "Desktop", exact: true }),
      ).toBeFocused();
      await page.keyboard.press("ArrowDown");
      await expect(
        dialog.getByRole("button", { name: "Dev2", exact: true }),
      ).toBeFocused();
      await input.fill(home + "/Al");
      await input.press("Tab");
      await expect(input).toHaveValue(home + "/AlphaOn");
      await expect(names).toHaveText(["AlphaOne", "AlphaOnly"]);
      await input.fill(home + "/Develop");
      await input.press("Tab");
      await expect(input).toHaveValue(home + "/Developer/");
      await expect(names).toHaveText(["Docs"]);
      await expect(
        dialog.getByRole("button", { name: "Open folder", exact: true }),
      ).toBeEnabled();
      await input.fill(home + "/NoSuchFolder");
      await expect(dialog.locator(".directory-list")).toContainText(
        "No matching folders",
      );
      await expect(names).toHaveCount(0);
      const createFolder = dialog.getByRole("button", {
        name: "Create folder “NoSuchFolder”",
      });
      await expect(createFolder).toBeVisible();
      await createFolder.click();
      await expect(input).toHaveValue(home + "/NoSuchFolder");
      await expect(
        dialog.getByRole("button", { name: "Open folder", exact: true }),
      ).toBeEnabled();
      let release!: () => void;
      const seen = new Promise<void>((resolve) => {
        release = resolve;
      });
      await page.route("**/v1/commands", async (route) => {
        const data = route.request().postDataJSON();
        if (
          data.type === "directory.list" &&
          data.payload.path === home + "/Developer"
        ) {
          release();
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
        await route.continue();
      });
      await input.fill(home + "/Developer/Do");
      await seen;
      await input.fill(home + "/Desktop/P");
      await expect(names).toHaveText(["Pictures"]);
      await expect(input).toHaveValue(home + "/Desktop/P");
      // The delayed previous parent must not overwrite the newer draft or results.
      await page.waitForTimeout(600);
      await expect(names).toHaveText(["Pictures"]);
      await input.press("ArrowDown");
      await expect(
        dialog.getByRole("button", { name: "Pictures", exact: true }),
      ).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(input).toHaveValue(home + "/Desktop/Pictures");
      await expect(
        dialog.getByRole("button", { name: "Open folder", exact: true }),
      ).toBeEnabled();
      await page.keyboard.press("Escape");
      await expect(dialog).toHaveCount(0);
      await expect(
        page.getByRole("button", { name: "Add project", exact: true }),
      ).toBeFocused();
    } finally {
      releaseInitial();
      await page.unrouteAll({ behavior: "wait" });
      await page.close();
      await fixture.close();
    }
  });
