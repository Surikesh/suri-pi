import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { updateFixture } from "../support/update-fixture.js";

async function fixtureForCurrentUi() {
  const latest = JSON.parse(
    await readFile(resolve(".build/ui/latest.json"), "utf8"),
  );
  return updateFixture(resolve(".build/ui", latest.buildId));
}

test("user-message marks navigate the loaded transcript without losing a draft", async ({
  page,
}, testInfo) => {
  const fixture = await fixtureForCurrentUi();
  try {
    const session = await fixture.seed();
    for (let index = 0; index < 8; index++) {
      for (const [role, text] of [
        ["user", `Synthetic question ${index}: what happened here?`],
        [
          "assistant",
          `Synthetic answer ${index}. ${"Detailed explanation for the reader. ".repeat(48)}`,
        ],
      ]) {
        fixture.host.publish(`session:${session.id}`, "message.upsert", {
          messageId: `${role}-${index}`,
          role,
          revision: 1,
          final: true,
          blocks: [{ id: `text-${role}-${index}`, kind: "text", text }],
        });
      }
    }
    const grant = await fixture.bootstrap();
    await page.goto(grant.origin + "/#nonce=" + grant.nonce);
    await expect
      .poll(() =>
        page.evaluate(() => window.suriUpdate?.ready).catch(() => false),
      )
      .toBe(true);
    await page.getByRole("button", { name: /Synthetic question 0/ }).click();
    const nav = page.getByRole("navigation", { name: "Your messages" });
    await expect(nav.getByRole("button")).toHaveCount(8);
    await expect(
      nav.getByRole("button", { name: /message 8:/ }),
    ).toHaveAttribute("aria-current", "location");
    await page
      .getByRole("textbox", { name: "Message Pi" })
      .fill("Unsent work stays here");
    await nav.getByRole("button", { name: /message 2:/ }).hover();
    await expect(page.getByRole("tooltip")).toHaveText(
      "Synthetic question 1: what happened here?",
    );
    await nav.getByRole("button", { name: /message 2:/ }).click();
    await expect(
      nav.getByRole("button", { name: /message 2:/ }),
    ).toHaveAttribute("aria-current", "location");
    await expect
      .poll(async () =>
        page
          .locator('[data-transcript-id="message:user-1"]')
          .evaluate((element) =>
            Math.round(element.getBoundingClientRect().top),
          ),
      )
      .toBeLessThan(170);
    await expect(page.getByRole("textbox", { name: "Message Pi" })).toHaveValue(
      "Unsent work stays here",
    );
    await page.screenshot({
      path: testInfo.outputPath("turn-navigator-desktop.png"),
    });
    await nav.getByRole("button", { name: /message 5:/ }).focus();
    await expect(page.getByRole("tooltip")).toHaveText(
      "Synthetic question 4: what happened here?",
    );
    await page.keyboard.press("Enter");
    await expect(
      nav.getByRole("button", { name: /message 5:/ }),
    ).toHaveAttribute("aria-current", "location");
    await page
      .locator('[data-transcript-id="message:user-5"]')
      .evaluate((element) => element.scrollIntoView({ block: "start" }));
    await expect(
      nav.getByRole("button", { name: /message 6:/ }),
    ).toHaveAttribute("aria-current", "location");
    await page.getByRole("button", { name: /Jump to latest/ }).click();
    await expect(
      nav.getByRole("button", { name: /message 8:/ }),
    ).toHaveAttribute("aria-current", "location");
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(nav).toBeHidden();
    await expect(page.getByRole("textbox", { name: "Message Pi" })).toHaveValue(
      "Unsent work stays here",
    );
    await page.screenshot({
      path: testInfo.outputPath("turn-navigator-narrow.png"),
    });
  } finally {
    await fixture.close();
  }
});

test("loading earlier history adds its user messages to the navigator", async ({
  page,
}) => {
  const fixture = await fixtureForCurrentUi();
  try {
    const session = await fixture.seed();
    for (let index = 0; index < 55; index++)
      fixture.host.publish(`session:${session.id}`, "message.upsert", {
        messageId: `older-${index}`,
        role: "user",
        revision: 1,
        final: true,
        blocks: [
          {
            id: `older-text-${index}`,
            kind: "text",
            text: `Question ${index} in the synthetic history`,
          },
        ],
      });
    const grant = await fixture.bootstrap();
    await page.goto(grant.origin + "/#nonce=" + grant.nonce);
    await expect
      .poll(() =>
        page.evaluate(() => window.suriUpdate?.ready).catch(() => false),
      )
      .toBe(true);
    await page
      .getByRole("button", { name: /Question 0 in the synthetic history/ })
      .click();
    const nav = page.getByRole("navigation", { name: "Your messages" });
    await expect(nav.getByRole("button")).toHaveCount(40);
    await page.getByRole("button", { name: "Earlier messages" }).click();
    await expect(nav.getByRole("button")).toHaveCount(55);
    await nav.getByRole("button", { name: /message 1: Question 0/ }).click();
    await expect(
      page.locator('[data-transcript-id="message:older-0"]'),
    ).toBeInViewport();
    await expect(
      nav.getByRole("button", { name: /message 1: Question 0/ }),
    ).toHaveAttribute("aria-current", "location");
  } finally {
    await fixture.close();
  }
});
