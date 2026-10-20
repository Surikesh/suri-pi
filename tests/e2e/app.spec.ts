import { test, expect, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { control } from "../../apps/host/src/cli.js";
import { AxeBuilder } from "@axe-core/playwright";
test.beforeEach(async ({ page }) => {
  const root = (await readFile(".suri-local/e2e-root", "utf8")).trim();
  const b = await control(root, { type: "bootstrap" });
  await page.goto("/");
  await page.evaluate(
    async ({ nonce }) => {
      await fetch("/v1/bootstrap", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nonce }),
      });
    },
    { nonce: b.nonce },
  );
  await page.reload();
  await expect(page.getByRole("status")).toContainText("Connected");
  // The shared seeded fixture persists host preferences across tests (and browsers).
  // Restore the navigation baseline rather than letting a previous view test
  // change the shape of subsequent session locators.
  await page.getByRole("button", { name: "View options" }).click();
  const byProject = page.getByRole("menuitemradio", { name: "By project" });
  if ((await byProject.getAttribute("aria-checked")) !== "true")
    await byProject.click();
  await page.keyboard.press("Escape");
});
for (const width of [1440, 760, 390])
  test(`conversation and draft survive navigation at ${width}`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    if (width < 900)
      await page.getByRole("button", { name: "Open navigation" }).click();
    await page.getByRole("button", { name: "A quiet place to build" }).click();
    const heading = page.getByRole("heading", { name: "A small beginning" });
    await expect(heading).toBeVisible();
    await expect(heading).toHaveCSS("font-size", "17px");
    await expect(heading).toHaveCSS("font-weight", "600");
    const assistant = page.locator(".message.assistant").first();
    await expect(assistant.locator("strong")).toHaveCSS("font-weight", "600");
    const metadata = assistant.locator(".message-body + .message-meta");
    await expect(metadata).toBeVisible();
    await expect(metadata).toHaveCSS("justify-content", "flex-end");
    await expect(
      metadata.getByRole("button", { name: "Copy message" }).locator("svg"),
    ).toBeVisible();
    await page
      .getByRole("textbox", { name: "Message Pi" })
      .fill("Synthetic unsent draft");
    await page.reload();
    await expect(page.getByRole("textbox", { name: "Message Pi" })).toHaveValue(
      "Synthetic unsent draft",
    );
    const composerRail = page.locator(".composer-rail");
    expect(
      await composerRail.evaluate(
        (element) => getComputedStyle(element).backgroundColor,
      ),
    ).toBe("rgba(0, 0, 0, 0)");
    expect(
      await page.locator(".transcript").evaluate((element) => ({
        track: getComputedStyle(element, "::-webkit-scrollbar-track")
          .backgroundColor,
        border: getComputedStyle(element, "::-webkit-scrollbar-track")
          .borderStyle,
        firefox: getComputedStyle(element).scrollbarColor,
      })),
    ).toMatchObject({ track: "rgba(0, 0, 0, 0)", border: "none" });
    expect(
      await page.locator(".sidebar nav").evaluate((element) => ({
        firefox: getComputedStyle(element).scrollbarWidth,
        display: getComputedStyle(element, "::-webkit-scrollbar").display,
        width: getComputedStyle(element, "::-webkit-scrollbar").width,
      })),
    ).toEqual({ firefox: "none", display: "none", width: "0px" });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`suri-${width}.png`) });
    await page.getByRole("button", { name: "Open workspace details" }).click();
    await expect(page.getByRole("tab", { name: "Files" })).toBeVisible();
    await page.getByRole("button", { name: "Close details" }).click();
  });
test("closed activity does not mount detail and restores disclosure after switching", async ({
  page,
}) => {
  await page
    .getByRole("button", { name: "A quiet place to build", exact: true })
    .click();
  const group = page
    .locator("details.activity-group")
    .filter({ hasText: "3 tool calls" });
  await expect(group).toHaveCount(1);
  await expect(group.locator(".activity-group-items")).toHaveCount(0);
  await group.locator(":scope > summary").click();
  await expect(group.locator(".activity-group-items")).toBeVisible();
  const tool = group.locator("details.tool").first();
  await expect(tool.locator(".activity-detail")).toHaveCount(0);
  await tool.locator(":scope > summary").click();
  await expect(tool.locator(".activity-detail")).toHaveCount(1);
  await tool.locator(":scope > summary").click();
  await expect(tool.locator(".activity-detail")).toHaveCount(0);
  await page.getByRole("button", { name: "Second workspace session" }).click();
  await expect(page.locator(".message.assistant")).toHaveCount(0);
  await page
    .getByRole("button", { name: "A quiet place to build", exact: true })
    .click();
  await expect(
    page.locator("details.activity-group").filter({ hasText: "3 tool calls" }),
  ).toHaveAttribute("open", "");
  await expect(page.getByRole("textbox", { name: "Message Pi" })).toBeEnabled();
});

test("shell code can be copied or run in the workspace terminal", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page
    .getByRole("button", { name: "A quiet place to build", exact: true })
    .click();
  await expect(page.getByRole("button", { name: "Copy code" })).toHaveCount(2);
  const run = page.getByRole("button", {
    name: "Run in terminal",
    exact: true,
  });
  await expect(run).toHaveCount(1);
  await run.click();
  const details = page.getByRole("complementary", {
    name: "Workspace details",
  });
  await expect(
    details.getByRole("tab", { name: "Terminal", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  const terminal = details.getByRole("region", { name: "Workspace terminal" });
  // The command may finish before the terminal becomes visible; assert output,
  // not the transient Running label.
  await expect(terminal.locator(".xterm-accessibility-tree")).toContainText(
    "SURI_CODE_RUN_OK",
  );
});

test("accessibility and inert content", async ({ page }) => {
  await page.getByRole("button", { name: "A quiet place to build" }).click();
  const results = await new AxeBuilder({ page }).analyze();
  expect(
    results.violations.filter((v) =>
      ["critical", "serious"].includes(v.impact ?? ""),
    ),
  ).toEqual([]);
});
test("IME Enter preserves the draft", async ({ page }) => {
  await page.getByRole("button", { name: "A quiet place to build" }).click();
  const editor = page.getByRole("textbox", { name: "Message Pi" });
  await editor.fill("日本語");
  await editor.dispatchEvent("keydown", {
    key: "Enter",
    code: "Enter",
    isComposing: true,
  });
  await expect(editor).toHaveValue("日本語");
});

test("asynchronous runtime rejection preserves the submitted draft", async ({
  page,
}) => {
  await page.getByRole("button", { name: "A quiet place to build" }).click();
  await page
    .getByRole("textbox", { name: "Message Pi" })
    .fill("Recover this synthetic draft");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Message Pi" })).toHaveValue(
    "Recover this synthetic draft",
  );
});
test("transcript follows late output growth only while pinned to latest", async ({
  page,
}) => {
  await page.setViewportSize({ width: 760, height: 600 });
  await page.getByRole("button", { name: "Open navigation" }).click();
  await page
    .getByRole("button", { name: "A quiet place to build", exact: true })
    .click();
  const transcript = page.locator(".transcript");
  await transcript.evaluate((element) =>
    element.scrollTo(0, element.scrollHeight),
  );
  await expect
    .poll(() =>
      transcript.evaluate(
        (element) =>
          element.scrollHeight - element.scrollTop - element.clientHeight,
      ),
    )
    .toBeLessThan(2);
  await transcript.locator(":scope > .rail").evaluate((element) => {
    const lateOutput = document.createElement("div");
    lateOutput.dataset.testid = "late-output";
    lateOutput.style.height = "240px";
    element.append(lateOutput);
  });
  await expect
    .poll(() =>
      transcript.evaluate(
        (element) =>
          element.scrollHeight - element.scrollTop - element.clientHeight,
      ),
    )
    .toBeLessThan(2);

  const composerHeight = await page
    .locator(".composer-rail")
    .evaluate((element) => element.getBoundingClientRect().height);
  await transcript.evaluate((element) =>
    element.scrollTo(0, element.scrollTop - 160),
  );
  await expect(
    page.getByRole("button", { name: "Jump to latest ↓" }),
  ).toBeVisible();
  expect(
    await page
      .locator(".composer-rail")
      .evaluate((element) => element.getBoundingClientRect().height),
  ).toBe(composerHeight);
  const anchoredTop = await transcript.evaluate((element) => element.scrollTop);
  await transcript.locator(":scope > .rail").evaluate((element) => {
    const lateOutput = document.createElement("div");
    lateOutput.style.height = "120px";
    element.append(lateOutput);
  });
  await page.waitForTimeout(50);
  expect(await transcript.evaluate((element) => element.scrollTop)).toBe(
    anchoredTop,
  );
});
test("message images render as compact preview tiles", async ({
  page,
}, testInfo) => {
  await page
    .getByRole("button", { name: "A quiet place to build", exact: true })
    .click();
  const body = page.locator(".message.user .message-body").first();
  const gallery = body.locator(".message-images");
  const first = gallery.locator(".message-image").first();
  await expect(first).toBeVisible();
  await gallery.evaluate((element) => {
    element.append(element.firstElementChild!.cloneNode(true));
  });
  const tiles = gallery.locator(".message-image");
  await expect(tiles).toHaveCount(2);
  for (const viewport of [
    { width: 1440, height: 900, name: "desktop" },
    { width: 760, height: 900, name: "narrow" },
    { width: 390, height: 844, name: "mobile" },
  ]) {
    await page.setViewportSize(viewport);
    await body.scrollIntoViewIfNeeded();
    const bubble = body.locator(".user-message-bubble");
    await expect(bubble).toHaveCSS("background-color", "rgb(243, 243, 243)");
    await expect(bubble.locator(".message-images")).toHaveCount(0);
    const bubbleBox = (await bubble.boundingBox())!;
    const galleryBox = (await gallery.boundingBox())!;
    const firstBox = (await tiles.nth(0).boundingBox())!;
    const secondBox = (await tiles.nth(1).boundingBox())!;
    expect(galleryBox.y).toBeGreaterThanOrEqual(
      bubbleBox.y + bubbleBox.height + 9,
    );
    expect(firstBox.x).toBe(bubbleBox.x);
    expect(secondBox.x).toBeGreaterThan(firstBox.x);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    const geometry = await tiles.evaluateAll((elements) =>
      elements.map((element) => {
        const rect = element.getBoundingClientRect();
        return {
          width: rect.width,
          height: rect.height,
          top: rect.top,
          fit: getComputedStyle(element.querySelector("img")!).objectFit,
        };
      }),
    );
    expect(geometry).toEqual([
      { width: 64, height: 64, top: geometry[0].top, fit: "cover" },
      { width: 64, height: 64, top: geometry[0].top, fit: "cover" },
    ]);
    await page.screenshot({
      path: testInfo.outputPath(`message-images-${viewport.name}.png`),
    });
  }
  await first.click();
  const preview = page.getByRole("dialog", {
    name: "Preview Image attachment",
  });
  await expect(
    preview.getByRole("img", { name: "Image attachment" }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(preview).toHaveCount(0);
  await expect(first).toBeFocused();
});
test("settings traps keyboard focus and restores it on Escape", async ({
  page,
}) => {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const modal = page.getByRole("dialog");
  await expect(modal).toBeVisible();
  for (let i = 0; i < 12; i++) {
    await page.keyboard.press("Tab");
    expect(
      await page.evaluate(
        () => !!document.activeElement?.closest('[role="dialog"]'),
      ),
    ).toBe(true);
  }
  await page.keyboard.press("Escape");
  await expect(modal).not.toBeVisible();
});

test("sidebar resizes directly and session view options persist", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const sidebar = page.getByRole("complementary", {
    name: "Projects and sessions",
  });
  const before = await sidebar.boundingBox();
  const separator = page.getByRole("separator", { name: "Resize sidebar" });
  const handle = await separator.boundingBox();
  expect(before).not.toBeNull();
  expect(handle).not.toBeNull();
  await page.mouse.move(handle!.x + handle!.width / 2, 200);
  await page.mouse.down();
  await page.mouse.move(handle!.x + 36, 200);
  await page.mouse.up();
  await expect(separator).toHaveAttribute("aria-valuenow", /2[5-9][0-9]/);

  await page.getByRole("button", { name: "A quiet place to build" }).click();
  await page.getByRole("button", { name: "View options" }).click();
  const menu = page.getByRole("menu", { name: "Session view options" });
  await menu.getByRole("menuitemradio", { name: "By list" }).click();
  const flatSession = page.getByRole("group", {
    name: "A quiet place to build",
    exact: true,
  });
  await expect(
    flatSession.getByText("Suri fixture", { exact: true }),
  ).toBeVisible();
  await expect(flatSession.locator(".session-project-icon")).toBeVisible();
  const shortcut = await flatSession.getAttribute("data-shortcut");
  expect(shortcut).toMatch(/^[1-9]$/);
  const sessionIcon = flatSession.locator(".session-project-icon");
  const iconBeforeShortcut = await sessionIcon.boundingBox();
  expect(iconBeforeShortcut).not.toBeNull();
  await page.keyboard.down("Meta");
  await expect
    .poll(() =>
      flatSession.evaluate((element) =>
        getComputedStyle(element, "::after").content.replaceAll('"', ""),
      ),
    )
    .toBe(shortcut);
  const iconWithShortcut = await sessionIcon.boundingBox();
  expect(iconWithShortcut).toEqual(iconBeforeShortcut);
  await page.keyboard.up("Meta");
  await expect
    .poll(() =>
      flatSession.evaluate(
        (element) => getComputedStyle(element, "::after").opacity,
      ),
    )
    .toBe("0");
  const tenthSession = page.locator(".flat-sessions .session-item").nth(9);
  if (await tenthSession.count())
    await expect(tenthSession).toHaveAttribute("data-shortcut", "");
  await page.reload();
  await expect(
    page
      .getByRole("group", { name: "A quiet place to build", exact: true })
      .getByText("Suri fixture", { exact: true }),
  ).toBeVisible();
  expect((await sidebar.boundingBox())!.width).toBeGreaterThan(before!.width);
  await page.getByRole("button", { name: "View options" }).click();
  await page
    .getByRole("menu", { name: "Session view options" })
    .getByRole("menuitemradio", { name: "By project" })
    .click();
  await expect(
    page.getByRole("menuitemradio", { name: "By project" }),
  ).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Control+Alt+L");
  await expect(
    page
      .getByRole("group", { name: "A quiet place to build", exact: true })
      .getByText("Suri fixture", { exact: true }),
  ).toBeVisible();
  await page.keyboard.press(`Meta+${shortcut}`);
  await expect(
    page.getByRole("button", { name: "Rename current session" }),
  ).toContainText("A quiet place to build");
  await expect(page.getByText("Preferences changed.")).toHaveCount(0);
});

test("untrusted Markdown stays inert and large output opens in bounded pages", async ({
  page,
}) => {
  const outbound: string[] = [];
  page.on("request", (r) => {
    if (r.url().startsWith("https://invalid.example")) outbound.push(r.url());
  });
  await page
    .getByRole("button", {
      name: "Untrusted content and artifacts",
      exact: true,
    })
    .click();
  await expect(
    page.getByText("[Remote image withheld]", { exact: true }),
  ).toBeVisible();
  expect(await page.evaluate(() => Boolean((window as any).__suriXss))).toBe(
    false,
  );
  expect(outbound).toEqual([]);
  expect(await page.locator('a[href^="javascript:"]').count()).toBe(0);
  await page.getByRole("button", { name: "Open complete output" }).click();
  await expect(
    page.getByRole("button", { name: "Next output page" }),
  ).toBeEnabled();
  const before = await page.locator("pre").last().innerText();
  expect(before.length).toBeLessThanOrEqual(16000);
  await page.getByRole("button", { name: "Next output page" }).click();
  await expect(
    page.getByRole("button", { name: "Previous output page" }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "Close output" }).click();
  await expect(
    page.getByRole("button", { name: "Next output page" }),
  ).toHaveCount(0);
});
test("extension widgets and queued delivery modes restore from snapshots", async ({
  page,
}) => {
  const showMore = page.getByRole("button", { name: "Show more" });
  if (await showMore.isVisible()) await showMore.click();
  await page
    .getByRole("button", { name: "Extension and queue fixture", exact: true })
    .click();
  await expect(
    page.getByText("Synthetic extension widget", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("tools: quiet", { exact: true })).toHaveCount(0);
  const queue = page.getByRole("region", { name: "Queued messages" });
  await expect(
    queue.getByRole("combobox", {
      name: "Delivery mode for queued message 1",
    }),
  ).toHaveValue("steer");
  await expect(
    queue.getByRole("textbox", { name: "Queued message 1" }),
  ).toHaveValue("Synthetic queued steer");
  const followUpMode = queue.getByRole("combobox", {
    name: "Delivery mode for queued message 2",
  });
  const followUpText = queue.getByRole("textbox", {
    name: "Queued message 2",
  });
  await expect(followUpMode).toHaveValue("followUp");
  await followUpMode.selectOption("steer");
  await followUpText.fill("Edited synthetic steer");
  await queue
    .getByRole("button", { name: "Apply queued message changes" })
    .nth(1)
    .click();
  await expect(
    queue.getByRole("textbox", { name: "Queued message 2" }),
  ).toHaveValue("Edited synthetic steer");
  await expect(
    queue.getByRole("combobox", {
      name: "Delivery mode for queued message 2",
    }),
  ).toHaveValue("steer");
  await page.getByRole("button", { name: "Use extension draft" }).click();
  await expect(page.getByRole("textbox", { name: "Message Pi" })).toHaveValue(
    "Draft from extension fixture",
  );
  await page.reload();
  await expect(page.getByRole("textbox", { name: "Message Pi" })).toHaveValue(
    "Draft from extension fixture",
  );
});

test("session row menu targets its own session and Escape restores focus", async ({
  page,
}) => {
  await page.getByRole("button", { name: "A quiet place to build" }).click();
  await page
    .getByRole("button", { name: "Untrusted content and artifacts" })
    .click({ button: "right" });
  const menu = page.getByRole("menu", {
    name: "Actions for Untrusted content and artifacts",
  });
  await expect(menu).toBeVisible();
  await menu.getByRole("menuitem", { name: "Rename" }).click();
  await menu.getByRole("textbox", { name: "Session name" }).fill("Menu target");
  await menu.getByRole("menuitem", { name: "Save name" }).click();
  await expect(page.getByRole("button", { name: "Menu target" })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Rename current session" }),
  ).toBeVisible();

  const trigger = page
    .getByRole("group", { name: "Menu target" })
    .getByRole("button", { name: "More actions" });
  await trigger.click();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).not.toBeVisible();
  await expect(trigger).toBeFocused();
  await trigger.click();
  const restoreMenu = page.getByRole("menu", {
    name: "Actions for Menu target",
  });
  await restoreMenu.getByRole("menuitem", { name: "Rename" }).click();
  await restoreMenu
    .getByRole("textbox", { name: "Session name" })
    .fill("Untrusted content and artifacts");
  await restoreMenu.getByRole("menuitem", { name: "Save name" }).click();
});

test("session actions match the reference menu and read state clears on open", async ({
  page,
}) => {
  const target = page.getByRole("group", {
    name: "A quiet place to build",
    exact: true,
  });
  await target.getByRole("button", { name: "More actions" }).click();
  const menu = page.getByRole("menu", {
    name: "Actions for A quiet place to build",
  });
  for (const action of [
    "Pin",
    "Mark as unread",
    "Highlight",
    "Reveal in Finder",
    "Copy project path",
    "Copy session ID",
    "Copy session link",
    "Rename",
    "Fork session",
    "Archive",
  ])
    await expect(menu.getByRole("menuitem", { name: action })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(menu).not.toBeVisible();
  await target
    .getByRole("button", { name: "A quiet place to build" })
    .click({ button: "right" });
  await expect(page.locator(".menu-scrim")).toHaveCSS(
    "background-color",
    "rgba(0, 0, 0, 0)",
  );
  await page.locator(".menu-scrim").click({ position: { x: 8, y: 8 } });
  await expect(menu).not.toBeVisible();
  await target.getByRole("button", { name: "More actions" }).click();
  await menu.getByRole("menuitem", { name: "Mark as unread" }).click();
  await page
    .getByRole("button", { name: "Untrusted content and artifacts" })
    .click();
  await expect(target.locator('.status-dot[title="Unread"]')).toBeVisible();
  await target.getByRole("button", { name: "A quiet place to build" }).click();
  await expect(target.locator('.status-dot[title="Unread"]')).toHaveCount(0);
});

test("internal custom records are not rendered as chat messages", async ({
  page,
}) => {
  await page
    .getByRole("button", { name: "A quiet place to build", exact: true })
    .click();
  await expect(
    page.getByText("INTERNAL TELEMETRY FIXTURE MUST NOT APPEAR AS A CHAT TURN"),
  ).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "A small beginning" }),
  ).toBeVisible();
});

test("a one-workspace project is not duplicated and can be removed safely", async ({
  page,
  browserName,
}) => {
  const projectName = `Accidental project ${browserName === "webkit" ? "WebKit" : "Chromium"}`;
  const project = page.locator(".project").filter({ hasText: projectName });
  await expect(project.getByText(projectName, { exact: true })).toHaveCount(1);
  await project
    .getByRole("button", { name: `Actions for project ${projectName}` })
    .click();
  const menu = page.getByRole("menu", {
    name: `Actions for project ${projectName}`,
  });
  await expect(
    menu.getByRole("menuitem", { name: "Reveal in Finder" }),
  ).toBeVisible();
  await expect(
    menu.getByRole("menuitem", { name: "Copy project path" }),
  ).toBeVisible();
  await menu.getByRole("menuitem", { name: "Remove from Suri…" }).click();
  await expect(menu).toContainText("folder and histories stay untouched");
  await menu.getByRole("menuitem", { name: "Confirm remove" }).click();
  await expect(page.getByText(projectName, { exact: true })).toHaveCount(0);
});

test("first accepted prompt assigns a local session name that survives reload", async ({
  page,
}) => {
  const sidebar = page.getByRole("complementary", {
    name: "Projects and sessions",
  });
  const emptyDraftRows = sidebar
    .locator(".session-item")
    .filter({ hasText: "New session" });
  const previousSessionId = await page.evaluate(() =>
    localStorage.getItem("suri.selected"),
  );
  await sidebar.locator("button.new-session").click();
  await page
    .getByRole("dialog", { name: "New session" })
    .getByRole("button", { name: "Create session" })
    .click();
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem("suri.selected")))
    .not.toBe(previousSessionId);
  await expect(emptyDraftRows).toHaveCount(1);
  const firstDraftId = await page.evaluate(() =>
    localStorage.getItem("suri.selected"),
  );
  await sidebar.locator("button.new-session").click();
  await page
    .getByRole("dialog", { name: "New session" })
    .getByRole("button", { name: "Create session" })
    .click();
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem("suri.selected")))
    .toBe(firstDraftId);
  await expect(emptyDraftRows).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Model" })).not.toHaveText(
    "Choose model",
  );
  const message = page.getByRole("textbox", { name: "Message Pi" });
  await message.fill(
    "Improve the compact session navigation for narrow windows",
  );
  await expect(message).toHaveValue(
    "Improve the compact session navigation for narrow windows",
  );
  const send = page.getByRole("button", { name: "Send message", exact: true });
  await expect(send).toBeEnabled();
  await send.click();
  await expect(emptyDraftRows).toHaveCount(0);
  await expect(
    sidebar
      .getByRole("button", {
        name: "Improve the compact session navigation for narrow windows",
      })
      .first(),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Rename current session" }),
  ).toContainText("Improve the compact session navigation for narrow windows");
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Rename current session" }),
  ).toContainText("Improve the compact session navigation for narrow windows");
});

test("rename stays available while active session actions are constrained", async ({
  page,
}) => {
  const group = page.getByRole("group", {
    name: "Running session",
    exact: true,
  });
  await group.getByRole("button", { name: "More actions" }).click();
  const menu = page.getByRole("menu", { name: "Actions for Running session" });
  await expect(menu.getByRole("menuitem", { name: "Rename" })).toBeEnabled();
  await expect(
    menu.getByRole("menuitem", { name: "Fork session" }),
  ).toBeDisabled();
  await expect(menu.getByRole("menuitem", { name: "Archive" })).toBeDisabled();
  await menu.getByRole("menuitem", { name: "Rename" }).click();
  await menu
    .getByRole("textbox", { name: "Session name" })
    .fill("Renamed live");
  await menu.getByRole("textbox", { name: "Session name" }).press("Enter");
  const renamed = page.getByRole("group", {
    name: "Renamed live",
    exact: true,
  });
  await expect(renamed).toBeVisible();
  await renamed.getByRole("button", { name: "More actions" }).click();
  const restore = page.getByRole("menu", { name: "Actions for Renamed live" });
  await restore.getByRole("menuitem", { name: "Rename" }).click();
  await restore
    .getByRole("textbox", { name: "Session name" })
    .fill("Running session");
  await restore.getByRole("menuitem", { name: "Save name" }).click();
});

test("files form a paged tree and workspaces remain distinct", async ({
  page,
}) => {
  await expect(
    page.getByRole("group", { name: "Second workspace", exact: true }),
  ).toContainText("Second workspace session");
  await page
    .getByRole("button", { name: "A quiet place to build", exact: true })
    .click();
  const linkedFile = page.getByRole("button", {
    name: "Open folder/nested.txt",
    exact: true,
  });
  await expect(linkedFile).toContainText("nested.txt");
  await expect(linkedFile).not.toContainText("herdr-local-file.invalid");
  await linkedFile.click({ button: "right" });
  const linkedFileMenu = page.getByRole("menu", {
    name: "Actions for nested.txt",
  });
  await expect(
    linkedFileMenu.getByRole("menuitem", { name: "Preview", exact: true }),
  ).toBeVisible();
  await expect(
    linkedFileMenu.getByRole("menuitem", {
      name: "Copy file contents",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    linkedFileMenu.getByRole("menuitem", { name: "Copy path", exact: true }),
  ).toBeVisible();
  await linkedFileMenu
    .getByRole("menuitem", { name: "Preview", exact: true })
    .click();
  await expect(
    page.getByRole("dialog", { name: "Preview nested.txt" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await page.getByRole("button", { name: "Open workspace details" }).click();
  const tree = page.getByRole("tree", { name: "Workspace files" });
  const file = tree.getByRole("treeitem", { name: "hello.txt", exact: true });
  const folder = tree.locator('button[title="folder"]');
  await expect(file).toBeVisible();
  await expect(file.locator(".file-type-icon.text svg")).toBeVisible();
  await expect(folder.locator(".file-type-icon.directory")).toBeVisible();
  await expect(tree.getByText(".hidden-fixture", { exact: true })).toHaveCount(
    0,
  );
  await page
    .getByRole("checkbox", { name: "Show hidden and generated items" })
    .check();
  await expect(
    tree.getByText(".hidden-fixture", { exact: true }),
  ).toBeVisible();
  await folder.click();
  await expect(
    tree.getByRole("treeitem", { name: "nested.txt", exact: true }),
  ).toBeVisible();
  await expect(tree.getByRole("button", { name: "Load more" })).toBeVisible();
  await tree.getByRole("button", { name: "Load more" }).click();
  await expect(tree.getByRole("button", { name: "Load more" })).toHaveCount(0);
});

test("slash and workspace context suggestions select without accidental send", async ({
  page,
}) => {
  let submits = 0;
  let compactions = 0;
  await page.route("**/v1/commands", async (route) => {
    const body = route.request().postDataJSON();
    if (body.type === "run.submit") submits++;
    if (body.type === "commands.list") {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          v: 1,
          id: body.id,
          status: "completed",
          result: {
            commands: [
              {
                name: "fix-tests",
                description: "Fix failing tests",
                source: "prompt",
              },
              {
                name: "skill:search",
                description: "Search with a skill",
                source: "skill",
              },
              {
                name: "extension-now",
                description: "Run an extension",
                source: "extension",
              },
              {
                name: "compact",
                description: "Manually compact the session context",
                source: "builtin",
                supported: true,
              },
            ],
          },
        }),
      });
      return;
    }
    if (body.type === "session.compact") {
      compactions++;
      await new Promise((resolve) => setTimeout(resolve, 500));
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          v: 1,
          id: body.id,
          status: "completed",
          result: {},
        }),
      });
      return;
    }
    await route.continue();
  });
  await page
    .getByRole("button", { name: "A quiet place to build", exact: true })
    .click();
  const editor = page.getByRole("textbox", { name: "Message Pi" });
  await editor.fill("/");
  await expect(
    page.getByRole("listbox", { name: "Slash commands" }),
  ).toBeVisible();
  await editor.fill("/fix");
  const slash = page.getByRole("listbox", { name: "Slash commands" });
  await expect(slash.getByText("Fix failing tests")).toBeVisible();
  await editor.press("Enter");
  await expect(editor).toHaveValue("/fix-tests ");
  expect(submits).toBe(0);

  await editor.fill("@hello");
  const files = page.getByRole("listbox", { name: "Workspace files" });
  await expect(
    files.getByRole("option", { name: "hello.txt", exact: true }),
  ).toBeVisible();
  await editor.press("Enter");
  await expect(
    page.locator(".attachments").getByText("hello.txt", { exact: true }),
  ).toBeVisible();
  await expect(editor).toHaveValue("");
  expect(submits).toBe(0);
  await page.getByRole("button", { name: "Remove hello.txt" }).click();
  await expect(
    page.locator(".attachments").getByText("hello.txt", { exact: true }),
  ).toHaveCount(0);

  await editor.fill("/compact");
  await expect(
    slash.getByText("Manually compact the session context"),
  ).toBeVisible();
  await editor.press("Enter");
  await page.waitForTimeout(50);
  expect(await editor.inputValue()).toBe("");
  await expect(editor).toHaveValue("");
  expect(compactions).toBe(1);
  expect(submits).toBe(0);
});

test("next-session starts a neighboring plan-driven session without sending the slash command to Pi", async ({
  page,
}) => {
  const seen: Array<{
    type: string;
    sessionId?: string;
    payload: Record<string, unknown>;
  }> = [];
  await page.route("**/v1/commands", async (route) => {
    const body = route.request().postDataJSON();
    if (!["file.read", "session.create", "run.submit"].includes(body.type)) {
      await route.continue();
      return;
    }
    seen.push({
      type: body.type,
      sessionId: body.sessionId,
      payload: body.payload,
    });
    const result =
      body.type === "session.create"
        ? { id: "next-session-id", revision: 1 }
        : body.type === "file.read"
          ? { content: "#", revision: "plan-revision" }
          : { accepted: true };
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ v: 1, id: body.id, status: "completed", result }),
    });
  });
  await page
    .getByRole("button", { name: "A quiet place to build", exact: true })
    .click();
  const editor = page.getByRole("textbox", { name: "Message Pi" });
  await editor.fill('/next-session docs/plans/task.md --name "Planned work"');
  await editor.press("Enter");
  await expect.poll(() => seen.length).toBe(3);
  expect(seen.map((item) => item.type)).toEqual([
    "file.read",
    "session.create",
    "run.submit",
  ]);
  expect(seen[0].payload).toMatchObject({
    path: "docs/plans/task.md",
    offset: 0,
    length: 1,
  });
  expect(seen[1].payload).toMatchObject({ name: "Planned work" });
  expect(seen[2].sessionId).toBe("next-session-id");
  expect(String(seen[2].payload.text)).toContain("docs/plans/task.md");
  expect(String(seen[2].payload.text)).not.toContain("/next-session");
});

test("Codex sessions show the remaining weekly allowance", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route("**/v1/commands", async (route) => {
    const body = route.request().postDataJSON();
    if (body.type === "usage.codex") {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          v: 1,
          id: body.id,
          status: "completed",
          result: {
            available: true,
            usedPercent: 37,
            remainingPercent: 63,
            windowSeconds: 604_800,
            resetsAt: "2033-05-18T03:33:20.000Z",
          },
        }),
      });
      return;
    }
    if (body.type === "session.context") {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          v: 1,
          id: body.id,
          status: "completed",
          result: {
            contextUsage: {
              tokens: 42_000,
              contextWindow: 128_000,
              percent: 32.8125,
            },
            compactionHistory: { tokens: 0 },
            codexUsage: {
              available: true,
              usedPercent: 37,
              remainingPercent: 63,
              windowSeconds: 604_800,
              resetsAt: "2033-05-18T03:33:20.000Z",
            },
          },
        }),
      });
      return;
    }
    const response = await route.fetch();
    const receipt = await response.json();
    if (body.type === "catalog.get") {
      receipt.result.runtimeMode = "live";
      for (const session of receipt.result.sessions ?? [])
        if (session.name === "A quiet place to build")
          session.model = { provider: "openai-codex", id: "gpt-fixture" };
    }
    await route.fulfill({ response, json: receipt });
  });
  await page.reload();
  await page.getByRole("button", { name: "Open navigation" }).click();
  await page
    .getByRole("button", { name: "A quiet place to build", exact: true })
    .click();

  await expect(page.locator(".context-usage")).toContainText(
    "Context: 42K / 128K · 33%",
  );
  const usage = page.locator(".codex-usage");
  await expect(usage).toContainText("Codex week: 63% left");
  await expect(
    usage.getByRole("progressbar", {
      name: "Weekly Codex allowance remaining",
    }),
  ).toHaveAttribute("aria-valuenow", "63");
  await expect(page.locator(".usage-footer")).not.toHaveCSS(
    "overflow-x",
    "scroll",
  );

  await page.getByRole("button", { name: "Open navigation" }).click();
  await page
    .getByRole("button", { name: "Second workspace session", exact: true })
    .click();
  await expect(page.locator(".codex-usage")).toContainText(
    "Codex week: 63% left",
  );
  await page.screenshot({
    path: testInfo.outputPath("global-codex-usage-narrow.png"),
  });
  // Background polls can still be inside route.fetch(); let them settle
  // before the context closes and disposes their responses.
  await page.unrouteAll({ behavior: "wait" });
});

test("tool and model controls show useful session values", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.route("**/v1/commands", async (route) => {
    const body = route.request().postDataJSON();
    // The picker resumes the session before listing models, and the shared
    // fixture runtime is an unvalidated candidate that the host refuses to resume.
    if (body.type === "session.resume") {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          v: 1,
          id: body.id,
          status: "completed",
          result: {},
        }),
      });
      return;
    }
    if (body.type === "model.list") {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          v: 1,
          id: body.id,
          status: "completed",
          result: {
            models: [
              { provider: "synthetic", id: "fixture-model", name: "Fixture" },
              { provider: "synthetic", id: "other-model", name: "Other" },
            ],
          },
        }),
      });
      return;
    }
    await route.continue();
  });
  await page
    .getByRole("button", { name: "A quiet place to build", exact: true })
    .click();
  await expect(page.getByRole("button", { name: "Model" })).toHaveText(
    "fixture-model",
  );
  await expect(page.getByRole("button", { name: "Thinking level" })).toHaveText(
    "medium",
  );
  await expect(page.locator(".context-usage")).toContainText(
    "Context: 42K / 128K · 33%",
  );
  await expect(page.locator(".context-usage")).toHaveAttribute(
    "aria-label",
    "Context: 42000 of 128000 tokens used, 86000 remaining, 33 percent",
  );
  for (const label of ["Model", "Thinking level"])
    expect(
      await page
        .getByRole("button", { name: label })
        .evaluate((element) => getComputedStyle(element, "::after").display),
    ).toBe("none");
  const tool = page.locator("details.tool").filter({ hasText: "hello.txt" });
  const failedTool = page.locator("details.tool.failed");
  const toolOnlyMessage = page
    .locator(".message.activity-message")
    .filter({ hasText: "acme-frontend" });
  const activityGroups = page.locator("details.activity-group");
  await expect(activityGroups).toHaveCount(2);
  const mixedActivityGroup = activityGroups.filter({ hasText: "2 tool calls" });
  const activityGroup = activityGroups.filter({ hasText: "3 tool calls" });
  await expect(activityGroup.locator(":scope > summary")).toContainText(
    "3 tool calls",
  );
  for (const group of [mixedActivityGroup, activityGroup]) {
    const summary = group.locator(":scope > summary");
    await expect(group).not.toHaveAttribute("open", "");
    await expect(summary).toHaveCSS("border-bottom-width", "0px");
    await summary.click();
    await expect(group).toHaveAttribute("open", "");
    await expect(summary).toHaveCSS("border-bottom-width", "0px");
  }
  const activitySummary = activityGroup.locator(":scope > summary");
  const collapseActivity = activityGroup.getByRole("button", {
    name: "Collapse 3 tool calls",
  });
  await expect(collapseActivity).toBeVisible();
  await expect(collapseActivity).toHaveCSS("border-top-width", "0px");
  await collapseActivity.click();
  await expect(activityGroup).not.toHaveAttribute("open", "");
  await expect(activitySummary).toBeFocused();
  await activitySummary.click();
  await expect(activityGroup).toHaveAttribute("open", "");
  await expect(
    page.locator(".activity-item.thinking").filter({
      hasText: "Reading registration data",
    }),
  ).toBeVisible();
  await expect(
    page
      .locator(".activity-item.thinking")
      .filter({ hasText: "Planning policy continuity investigation" })
      .locator(":scope > summary"),
  ).not.toContainText("**");
  await expect(tool.locator(":scope > summary")).toContainText(
    "Read·hello.txt",
  );
  await expect(
    page.locator("details.tool").filter({ hasText: "/tmp/script.py" }),
  ).toBeVisible();
  await expect(
    page.locator("details.tool").filter({ hasText: "acme-frontend" }),
  ).toBeVisible();
  const retryingTool = page
    .locator("details.tool.retrying")
    .filter({ hasText: "Resolve bounded frontend route" });
  await expect(retryingTool.locator(":scope > summary")).toContainText(
    "Bash·Resolve bounded frontend routeRetrying",
  );
  await expect(tool).toBeVisible();
  const activityRows = page.locator(".message-body").filter({
    has: page.locator(".activity-item.tool.completed"),
  });
  const iconAlignment = await activityRows.last().evaluate((element) => {
    const metrics = (selector: string) => {
      const item = element.querySelector(selector)!;
      const row = item.querySelector("summary")!.getBoundingClientRect();
      const icon = item
        .querySelector(".activity-icon svg")!
        .getBoundingClientRect();
      return {
        centerOffset: icon.top + icon.height / 2 - (row.top + row.height / 2),
        height: icon.height,
      };
    };
    const think = metrics(".activity-item.thinking");
    const write = metrics(".activity-item.tool.completed");
    return {
      centerDelta: Math.abs(think.centerOffset - write.centerOffset),
      heightDelta: Math.abs(think.height - write.height),
    };
  });
  expect(iconAlignment.centerDelta).toBeLessThanOrEqual(0.25);
  expect(iconAlignment.heightDelta).toBeLessThanOrEqual(0.25);
  expect(
    await activityGroup
      .locator(".activity-item > summary")
      .evaluateAll((rows) =>
        rows.map((row) => row.getBoundingClientRect().height),
      ),
  ).toEqual([28, 28, 28, 28, 28]);
  await expect(tool.locator(":scope > summary")).not.toContainText("Completed");
  await expect(failedTool).toBeVisible();
  await expect(failedTool.locator(".activity-state.failed")).toHaveText(
    "Failed",
  );
  await expect(retryingTool.locator(".activity-state.retrying")).toHaveText(
    "Retrying",
  );
  await expect(
    toolOnlyMessage.getByRole("button", { name: "Copy message" }),
  ).toHaveCount(0);
  const streamingThinking = page
    .locator(".message.activity-message")
    .filter({ hasText: "Preparing the final response" });
  await expect(streamingThinking).toBeVisible();
  await expect(
    activityGroup.locator(".activity-item.thinking").filter({
      hasText: "Preparing the final response",
    }),
  ).toHaveCount(1);
  await expect(
    page
      .locator(".message.assistant:not(.activity-message)")
      .filter({
        hasText: "Final response after tool activity.",
      })
      .locator(".activity-group"),
  ).toHaveCount(0);
  await expect(
    streamingThinking.getByRole("button", { name: "Copy message" }),
  ).toHaveCount(0);
  await expect(streamingThinking.locator(".flow-content")).toHaveCount(0);
  await expect(toolOnlyMessage).toHaveCSS("padding-right", "0px");
  await expect(tool).toHaveCSS("margin-left", "3px");
  await expect(
    page
      .locator(".message.assistant")
      .filter({ hasText: "A small beginning" })
      .getByRole("button", { name: "Copy message" }),
  ).toBeVisible();
  const finalResponse = page.locator(".message.assistant").last();
  await expect(finalResponse).toContainText(
    "Final response after tool activity.",
  );
  await expect(
    finalResponse.getByRole("button", { name: "Copy message" }),
  ).toBeVisible();
  await expect(page.getByText("stale-orphan.txt", { exact: true })).toHaveCount(
    0,
  );
  await expect(page.getByText("active-orphan-must-not-float")).toHaveCount(0);
  await expect(page.locator(".rail > .activity-item")).toHaveCount(0);
  const retrySummary = retryingTool.locator(".tool-summary");
  expect(
    await retrySummary.evaluate(
      (element) => element.scrollWidth <= element.parentElement!.clientWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: testInfo.outputPath("tool-activity-desktop.png"),
  });
  for (const viewport of [
    { width: 760, height: 900, name: "narrow" },
    { width: 390, height: 844, name: "mobile" },
  ]) {
    await page.setViewportSize(viewport);
    await page
      .locator(".transcript")
      .evaluate((element) => (element.scrollTop = element.scrollHeight));
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await expect(tool).toHaveCSS("margin-left", "3px");
    await page.screenshot({
      path: testInfo.outputPath(`tool-activity-${viewport.name}.png`),
    });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await tool.locator(":scope > summary").focus();
  await page.keyboard.press("Enter");
  await expect(tool.locator(":scope > .activity-detail")).toBeVisible();
  await expect(tool).toHaveAttribute("open", "");
  const skillTool = page
    .locator("details.tool")
    .filter({ hasText: "acme-frontend" });
  await skillTool.locator(":scope > summary").focus();
  await page.keyboard.press("Enter");
  await expect(skillTool.locator(":scope > .activity-detail")).toBeVisible();
  expect(
    await tool.evaluate((element) => getComputedStyle(element).borderStyle),
  ).toBe("none");
  await page.getByRole("button", { name: "Model" }).click();
  // The search-first picker lists models only after a query or "Show all models".
  await page.getByRole("button", { name: "Show all models" }).click();
  await expect(page.getByRole("listbox", { name: "Model" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "Model" })).toBeFocused();
  await page
    .getByRole("button", {
      name: "Untrusted content and artifacts",
      exact: true,
    })
    .click();
  const contextUsage = page.locator(".context-usage");
  await expect(contextUsage).toContainText("Context not reported by Pi");
  const contextBox = await contextUsage.boundingBox();
  const composerBox = await page.locator(".composer").boundingBox();
  expect(contextBox).not.toBeNull();
  expect(composerBox).not.toBeNull();
  expect(contextBox!.y).toBeGreaterThanOrEqual(
    composerBox!.y + composerBox!.height,
  );
  expect(
    await page
      .getByRole("button", { name: "Attach file" })
      .evaluate((element) => getComputedStyle(element).backgroundColor),
  ).toBe("rgba(0, 0, 0, 0)");
  await expect(page.getByRole("button", { name: "Model" })).toHaveText(
    "other-model",
  );
  await expect(page.locator("select[aria-label='Model']")).toHaveCount(0);
});

// The shared fixture runtime is an unvalidated candidate that the host refuses
// to resume, which surfaces an error banner and blocks model discovery.
async function stubSessionResume(page: Page) {
  await page.route("**/v1/commands", async (route) => {
    const body = route.request().postDataJSON();
    if (body.type !== "session.resume") return route.fallback();
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        v: 1,
        id: body.id,
        status: "completed",
        result: {},
      }),
    });
  });
}

test("transcript activity owns compact and full flow rhythm", async ({
  page,
}, testInfo) => {
  await stubSessionResume(page);
  await page
    .getByRole("button", { name: "A quiet place to build", exact: true })
    .click();
  const activityGroups = page.locator("details.activity-group");
  await expect(activityGroups).toHaveCount(2);
  for (let index = 0; index < 2; index++) {
    const group = activityGroups.nth(index);
    await expect(group).not.toHaveAttribute("open", "");
    await group.locator(":scope > summary").click();
  }
  const transcript = page.locator(".transcript");
  const measure = () =>
    page.locator(".rail").evaluate((rail) => {
      const items: Array<{ kind: string; top: number; bottom: number }> = [];
      for (const message of rail.querySelectorAll<HTMLElement>(
        "article.message",
      )) {
        if (message.classList.contains("user")) {
          const rect = message.getBoundingClientRect();
          items.push({ kind: "content", top: rect.top, bottom: rect.bottom });
          continue;
        }
        for (const item of message.querySelectorAll<HTMLElement>(
          ":scope > .message-body > .transcript-flow-item",
        )) {
          const rect = item.getBoundingClientRect();
          items.push({
            kind: item.classList.contains("flow-activity")
              ? "activity"
              : "content",
            top: rect.top,
            bottom: rect.bottom,
          });
        }
      }
      return items.map((item, index) => ({
        ...item,
        nextKind: items[index + 1]?.kind,
        gap:
          index + 1 < items.length
            ? items[index + 1].top - item.bottom
            : undefined,
      }));
    });

  for (const viewport of [
    { width: 1440, height: 900, name: "desktop" },
    { width: 760, height: 900, name: "narrow" },
    { width: 390, height: 844, name: "mobile" },
  ]) {
    await page.setViewportSize(viewport);
    // Re-pin until layout is stable: highlighting and intrinsic-size updates
    // after a viewport change can grow the transcript after a single scroll.
    await expect
      .poll(() =>
        transcript.evaluate(async (element) => {
          const frame = () =>
            new Promise<void>((done) => requestAnimationFrame(() => done()));
          for (let attempt = 0; attempt < 3; attempt++) {
            element.scrollTo(0, element.scrollHeight);
            await frame();
            await frame();
          }
          return (
            element.scrollHeight - element.scrollTop - element.clientHeight
          );
        }),
      )
      .toBeLessThan(2);
    const items = await measure();
    const adjacent = items.filter((item) => item.gap !== undefined);
    expect(adjacent.every((item) => item.gap! >= -0.5)).toBe(true);
    const compact = adjacent.filter(
      (item) => item.kind === "activity" && item.nextKind === "activity",
    );
    expect(compact.length).toBeGreaterThan(2);
    for (const item of compact) expect(item.gap).toBeCloseTo(4, 0);
    const transitions = adjacent.filter((item) => item.kind !== item.nextKind);
    expect(transitions.length).toBeGreaterThan(1);
    for (const item of transitions)
      expect([16, 61]).toContain(Math.round(item.gap!));

    const last = items.at(-1)!;
    const composerRail = await page.locator(".composer-rail").boundingBox();
    expect(composerRail).not.toBeNull();
    expect(last.bottom).toBeLessThanOrEqual(composerRail!.y - 8);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);

    const expandable = page.locator("details.tool.failed");
    if (!(await expandable.getAttribute("open")))
      await expandable.locator(":scope > summary").click();
    const expanded = await measure();
    expect(
      expanded
        .filter((item) => item.gap !== undefined)
        .every((item) => item.gap! >= -0.5),
    ).toBe(true);

    const jump = page.getByRole("button", { name: "Jump to latest ↓" });
    // Re-apply the scroll until it sticks: late layout growth after the
    // expansion can re-pin the transcript to the latest message.
    await expect
      .poll(async () => {
        await transcript.evaluate((element) =>
          element.scrollTo(
            0,
            Math.max(0, element.scrollHeight - element.clientHeight - 120),
          ),
        );
        return jump.isVisible();
      })
      .toBe(true);
    const overlaps = await page.locator(".rail").evaluate((rail) => {
      const button = document.querySelector<HTMLElement>(".jump")!;
      const composerRail =
        document.querySelector<HTMLElement>(".composer-rail")!;
      const jumpRect = button.getBoundingClientRect();
      const obstructionTop = composerRail.getBoundingClientRect().top;
      return Array.from(
        rail.querySelectorAll<HTMLElement>(
          ":scope > article.message.user, :scope > article.message.assistant > .message-body > .transcript-flow-item",
        ),
      ).some((item) => {
        const rect = item.getBoundingClientRect();
        const visible = rect.bottom > 60 && rect.bottom <= obstructionTop;
        return (
          visible &&
          rect.left < jumpRect.right &&
          rect.right > jumpRect.left &&
          rect.top < jumpRect.bottom &&
          rect.bottom > jumpRect.top
        );
      });
    });
    expect(overlaps).toBe(false);
    await page.screenshot({
      path: testInfo.outputPath(`transcript-flow-${viewport.name}.png`),
    });
    await jump.click();
  }
});

test("multi-history preview distinguishes outcomes before importing", async ({
  page,
}) => {
  await page.route("**/v1/commands", async (route) => {
    const body = route.request().postDataJSON();
    if (body.type === "session.importPreview") {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          v: 1,
          id: body.id,
          status: "completed",
          result: {
            candidates: [
              {
                grantId: "ready",
                fileName: "ready.jsonl",
                name: "Useful history",
                cwd: "/fixture/project",
                status: "ready",
              },
              {
                grantId: "duplicate",
                fileName: "duplicate.jsonl",
                status: "duplicate",
              },
              {
                grantId: "mismatch",
                fileName: "mismatch.jsonl",
                cwd: "/another/project",
                status: "path-mismatch",
              },
              {
                grantId: "invalid",
                fileName: "invalid.jsonl",
                status: "incompatible",
                reason: "This is not a compatible Pi history.",
              },
            ],
          },
        }),
      });
      return;
    }
    if (body.type === "session.importBatch") {
      expect(body.payload.fileGrantIds).toEqual(["ready"]);
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          v: 1,
          id: body.id,
          status: "completed",
          result: {
            imported: [{ grantId: "ready", status: "imported" }],
            skipped: [],
          },
        }),
      });
      return;
    }
    await route.continue();
  });
  await page
    .getByRole("button", { name: "A quiet place to build", exact: true })
    .click();
  await page.evaluate(async () =>
    window.suriImportFiles?.([
      { grantId: "ready" },
      { grantId: "duplicate" },
      { grantId: "mismatch" },
      { grantId: "invalid" },
    ]),
  );
  const preview = page.getByRole("region", { name: "Import preview" });
  await expect(preview).toContainText("Useful history");
  await expect(preview).toContainText("duplicate");
  await expect(preview).toContainText("path-mismatch");
  await expect(preview).toContainText("incompatible");
  await expect(preview.getByRole("checkbox")).toHaveCount(4);
  await expect(preview.getByRole("checkbox").nth(1)).toBeDisabled();
  await preview.getByRole("button", { name: "Import selected" }).click();
  await expect(preview).toContainText("imported");
});
