import { expect, test } from "@playwright/test";
import { browserHost } from "../support/browser-host.js";

for (const width of [1440, 390]) {
  test(`new session can select a model before sending at ${width}px`, async ({
    page,
  }) => {
    const fixture = await browserHost();
    try {
      await page.setViewportSize({ width, height: 844 });
      await fixture.login(page);
      if (width < 900)
        await page.getByRole("button", { name: "Open navigation" }).click();
      await page
        .getByRole("button", { name: "New session ⌃⌥N", exact: true })
        .click();
      await page
        .getByRole("dialog", { name: "New session" })
        .getByRole("button", { name: "Create session" })
        .click();
      const model = page.getByRole("button", { name: "Model", exact: true });
      await expect(model).toBeVisible();
      await model.click();
      // The search-first picker lists models only on request.
      await page.getByRole("button", { name: "Show all models" }).click();
      const list = page.getByRole("listbox", { name: "Model", exact: true });
      await expect(list.getByRole("option").first()).toBeVisible();
      await expect(list).not.toContainText("Runtime metadata is unavailable");
      await list.getByRole("option").first().click();
      await expect(model).not.toContainText("Choose model");
      await expect(
        page.getByRole("textbox", { name: "Message Pi" }),
      ).toHaveValue("");
    } finally {
      await fixture.close();
    }
  });
}
