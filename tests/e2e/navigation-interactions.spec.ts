import { test, expect, type Page, type Locator } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { browserHost } from "../support/browser-host.js";
import { control } from "../../apps/host/src/cli.js";

test("navigation search keeps the caret inset at desktop and narrow widths", async ({
  page,
}, testInfo) => {
  const fixture = await browserHost();
  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    await fixture.login(page);
    const search = page.getByRole("textbox", {
      name: "Filter projects and sessions",
    });
    await search.click();
    await expect(search).toBeFocused();
    await expect
      .poll(() =>
        search.evaluate((input) => getComputedStyle(input).paddingLeft),
      )
      .toBe("12px");
    await page.screenshot({
      path: testInfo.outputPath("navigation-search-desktop.png"),
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("button", { name: "Open navigation" }).click();
    await search.click();
    await expect(search).toBeFocused();
    await expect
      .poll(() =>
        search.evaluate((input) => getComputedStyle(input).paddingLeft),
      )
      .toBe("12px");
    await page.screenshot({
      path: testInfo.outputPath("navigation-search-narrow.png"),
    });
  } finally {
    await fixture.close();
  }
});

async function manual(page: Page) {
  await page.getByRole("button", { name: "View options", exact: true }).click();
  await page
    .getByRole("menuitemradio", { name: "Manual", exact: true })
    .click();
  await page.keyboard.press("Escape");
}
async function drag(
  page: Page,
  source: Locator,
  target: Locator,
  after = false,
) {
  const from = (await source.boundingBox())!;
  const to = (await target.boundingBox())!;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(
    from.x + from.width / 2 + 10,
    from.y + from.height / 2,
    { steps: 3 },
  );
  await page.mouse.move(
    to.x + to.width / 2,
    to.y + (after ? to.height - 2 : 2),
    { steps: 10 },
  );
  await page.mouse.move(
    to.x + to.width / 2 + 1,
    to.y + (after ? to.height - 2 : 2),
  );
  await expect(
    page.locator(after ? ".drop-after" : ".drop-before"),
  ).toHaveCount(1);
  await page.mouse.up();
}

test("manual project insertion and session order survive reload without moving ownership", async ({
  page,
}) => {
  const fixture = await browserHost();
  try {
    for (const label of ["Bravo", "Charlie"]) {
      const path = join(fixture.root, label);
      await mkdir(path);
      const grant = await control(fixture.data, {
        type: "grant",
        kind: "directory",
        path,
      });
      await fixture.execute("project.add", { directoryGrantId: grant.grantId });
    }
    for (const name of ["Second", "Third"])
      await fixture.execute("session.create", {
        workspaceId: fixture.workspaceId,
        runtimeId: fixture.runtime.id,
        name,
      });
    await page.setViewportSize({ width: 1440, height: 900 });
    await fixture.login(page);
    const project = (label: string) =>
      page.locator(".project-row").filter({
        has: page.getByRole("button", {
          name: `Set icon for ${label}`,
          exact: true,
        }),
      });
    await expect(project("workspace")).toHaveAttribute("draggable", "false");
    await expect(
      page.getByRole("button", { name: "Second", exact: true }),
    ).toHaveAttribute("draggable", "false");
    await manual(page);
    await expect(project("workspace")).toHaveAttribute("draggable", "true");
    await expect(page.locator(".project").first()).not.toHaveAttribute(
      "draggable",
      "true",
    );
    await drag(page, project("Charlie"), project("workspace"));
    await expect(page.locator(".project-row > span")).toHaveText([
      "Charlie",
      "workspace",
      "Bravo",
    ]);
    await drag(page, project("Charlie"), project("Bravo"), true);
    await expect(page.locator(".project-row > span")).toHaveText([
      "workspace",
      "Bravo",
      "Charlie",
    ]);
    await drag(page, project("Charlie"), project("Bravo"));
    await expect(page.locator(".project-row > span")).toHaveText([
      "workspace",
      "Charlie",
      "Bravo",
    ]);
    const row = (name: string) =>
      page.getByRole("button", { name, exact: true });
    const names = page.locator(".workspace-group .session-copy > span");
    await expect(names).toHaveCount(3);
    await drag(page, row("Third"), row("Browser fixture"), true);
    await expect(names).toHaveText(["Second", "Browser fixture", "Third"]);
    await row("Third").focus();
    await page.keyboard.press("Alt+Shift+ArrowUp");
    await expect(names).toHaveText(["Second", "Third", "Browser fixture"]);
    await page.reload();
    await expect(names).toHaveText(["Second", "Third", "Browser fixture"]);
    await expect(page.locator(".project-row > span")).toHaveText([
      "workspace",
      "Charlie",
      "Bravo",
    ]);
    expect(
      fixture.host.store
        .list("session")
        .every((s) => s.workspaceId === fixture.workspaceId),
    ).toBe(true);
    await page
      .getByRole("button", { name: "View options", exact: true })
      .click();
    await page
      .getByRole("menuitemradio", { name: "Last updated", exact: true })
      .click();
    await page.keyboard.press("Escape");
    await expect(row("Third")).toHaveAttribute("draggable", "false");
  } finally {
    await fixture.close();
  }
});

test("session hover preview shows recency and the latest conversation message", async ({
  page,
}) => {
  const fixture = await browserHost();
  try {
    const created = await fixture.execute("session.create", {
      workspaceId: fixture.workspaceId,
      runtimeId: fixture.runtime.id,
      name: "Rich session history",
    });
    fixture.host.store.event(`session:${created.id}`, "message.upsert", {
      messageId: "user-message",
      role: "user",
      blocks: [{ type: "text", id: "user-block", text: "Earlier request" }],
      revision: 1,
      final: true,
    });
    fixture.host.store.event(`session:${created.id}`, "message.upsert", {
      messageId: "assistant-message",
      role: "assistant",
      blocks: [
        {
          type: "text",
          id: "assistant-block",
          text: "The latest agent answer explains what is inside this session.",
        },
      ],
      revision: 1,
      final: true,
    });
    fixture.host.store.put("session", {
      ...created,
      updatedAt: new Date(Date.now() - 35 * 24 * 60 * 60 * 1000).toISOString(),
    });
    await page.setViewportSize({ width: 1440, height: 900 });
    await fixture.login(page);
    const row = page.getByRole("button", {
      name: "Rich session history",
      exact: true,
    });
    await row.hover();
    const preview = page.locator("#session-history-preview");
    await expect(preview).toBeVisible();
    await expect(preview).toContainText("Rich session history");
    await expect(preview).toContainText("1mo");
    await expect(preview).toContainText("Pi");
    await expect(preview).toContainText(
      "The latest agent answer explains what is inside this session.",
    );
    await expect(preview).not.toContainText("workspace");
    const [rowBox, previewBox] = await Promise.all([
      row.boundingBox(),
      preview.boundingBox(),
    ]);
    expect(previewBox!.x).toBeGreaterThan(rowBox!.x + rowBox!.width);
    await page.mouse.move(900, 700);
    await expect(preview).toHaveCount(0);
    await row.focus();
    await expect(preview).toBeVisible();
  } finally {
    await fixture.close();
  }
});

test("project new-session action creates a distinct session instead of reopening an empty one", async ({
  page,
}) => {
  const fixture = await browserHost();
  try {
    const existing = await fixture.execute("session.create", {
      workspaceId: fixture.workspaceId,
      runtimeId: fixture.runtime.id,
    });
    const before = fixture.host.store.list("session").length;
    await page.setViewportSize({ width: 1440, height: 900 });
    await fixture.login(page);
    const project = page.locator(".project").filter({
      has: page.getByRole("button", {
        name: "Set icon for workspace",
        exact: true,
      }),
    });
    await project
      .getByRole("button", { name: "New session in workspace", exact: true })
      .click();
    await expect
      .poll(() => fixture.host.store.list("session").length)
      .toBe(before + 1);
    await expect
      .poll(() => new URL(page.url()).searchParams.get("session"))
      .not.toBe(existing.id);
    await expect(
      project
        .locator(".session-item.selected")
        .getByRole("button", { name: "New session", exact: true }),
    ).toBeVisible();
  } finally {
    await fixture.close();
  }
});

for (const width of [1440, 390])
  test(`project disclosure session limit and global collapse at ${width}`, async ({
    page,
    browserName,
  }) => {
    const fixture = await browserHost();
    try {
      for (let index = 1; index <= 5; index++)
        await fixture.execute("session.create", {
          workspaceId: fixture.workspaceId,
          runtimeId: fixture.runtime.id,
          name: `Recent ${index}`,
        });
      await page.setViewportSize({ width, height: 900 });
      await fixture.login(page);
      const showNavigation = async () => {
        const open = page.getByRole("button", {
          name: "Open navigation",
          exact: true,
        });
        if (await open.isVisible()) await open.click();
      };
      await showNavigation();
      const project = page.locator(".project").filter({
        has: page.getByRole("button", {
          name: "Set icon for workspace",
          exact: true,
        }),
      });
      const row = project.locator(".project-row");
      const projectChevron = project.locator(".project-chevron svg");
      const sessions = project.locator(".session-item");
      const newSession = project.getByRole("button", {
        name: "New session in workspace",
        exact: true,
      });
      const projectMenu = project.getByRole("button", {
        name: "Actions for project workspace",
        exact: true,
      });
      const firstSession = sessions.first();
      const sessionMenu = firstSession.getByRole("button", {
        name: "More actions",
        exact: true,
      });
      await expect(row).toHaveAttribute("data-expanded", "true");
      await expect(projectChevron).toHaveCount(0);
      await expect(project.locator(".project-icon path")).toHaveAttribute(
        "d",
        "M3 10V8a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-8Zm0 1h18",
      );
      await expect(sessions).toHaveCount(5);
      await expect(
        project.getByRole("button", { name: "Browser fixture", exact: true }),
      ).toBeVisible();
      await expect(newSession).toHaveAttribute("title", "New session");
      await expect(
        row.locator(".project-menu-button + .project-new-session"),
      ).toHaveCount(1);
      for (const action of [projectMenu, newSession])
        await expect
          .poll(() =>
            action.evaluate((element) => getComputedStyle(element).opacity),
          )
          .toBe("0");
      await row.hover();
      for (const action of [projectMenu, newSession])
        await expect
          .poll(() =>
            action.evaluate((element) => getComputedStyle(element).opacity),
          )
          .toBe("1");
      const [menuBox, newSessionBox] = await Promise.all([
        projectMenu.boundingBox(),
        newSession.boundingBox(),
      ]);
      expect(menuBox?.y).toBe((newSessionBox?.y ?? 0) + 2);

      const title = page.getByRole("button", {
        name: "Rename current session",
      });
      const titleText = title.locator("strong");
      const [titleBox, titleTextBox] = await Promise.all([
        title.boundingBox(),
        titleText.boundingBox(),
      ]);
      expect(titleBox?.width).toBeLessThanOrEqual(
        (titleTextBox?.width ?? 0) + 1,
      );
      await page.screenshot({
        path: `.suri-local/diagnostics/afk-project-actions-${browserName}-${width}.png`,
      });
      if (width === 390) await page.keyboard.press("Escape");
      await title.hover();
      await page.screenshot({
        path: `.suri-local/diagnostics/afk-session-title-${browserName}-${width}.png`,
      });
      if (width === 390) await showNavigation();
      await page.mouse.move(width - 5, 400);
      await row.focus();
      for (const action of [projectMenu, newSession])
        await expect
          .poll(() =>
            action.evaluate((element) => getComputedStyle(element).opacity),
          )
          .toBe("0");
      await expect(row).toHaveAttribute("data-expanded", "true");
      await expect
        .poll(() =>
          sessionMenu.evaluate((element) => getComputedStyle(element).opacity),
        )
        .toBe("0");
      await firstSession.hover();
      await expect
        .poll(() =>
          sessionMenu.evaluate((element) => getComputedStyle(element).opacity),
        )
        .toBe("1");
      await project.getByRole("button", { name: "Show more" }).click();
      await expect(sessions).toHaveCount(6);
      await project.getByRole("button", { name: "Show less" }).click();
      await expect(sessions).toHaveCount(5);
      await expect(
        project.getByRole("button", { name: "Browser fixture", exact: true }),
      ).toBeVisible();
      await project
        .getByRole("button", {
          name: "Actions for project workspace",
          exact: true,
        })
        .click();
      await expect(row).toHaveAttribute("data-expanded", "true");
      await page.keyboard.press("Escape");
      await newSession.click();
      await expect
        .poll(() => fixture.host.store.list("session").length)
        .toBe(7);
      await showNavigation();
      await expect(
        project.locator(".session-item").filter({ hasText: "New session" }),
      ).toBeVisible();
      await expect(
        project
          .locator(".session-item.selected")
          .getByRole("button", { name: "New session", exact: true }),
      ).toBeVisible();
      await expect(row).toHaveAttribute("data-expanded", "true");
      await row.click();
      await expect(row).toHaveAttribute("data-expanded", "false");
      await expect(projectChevron).toHaveCount(0);
      await expect(sessions).toHaveCount(0);
      await expect(
        page.getByRole("button", { name: "Expand all", exact: true }),
      ).toBeVisible();
      await page
        .getByRole("button", { name: "Expand all", exact: true })
        .click();
      await expect(row).toHaveAttribute("data-expanded", "true");
      await expect(projectChevron).toHaveCount(0);
      await expect(
        page.getByRole("button", { name: "Collapse all", exact: true }),
      ).toBeVisible();
      await page
        .getByRole("button", { name: "Collapse all", exact: true })
        .click();
      await expect(row).toHaveAttribute("data-expanded", "false");
      await expect(projectChevron).toHaveCount(0);
      await fixture.restart(page);
      await showNavigation();
      await expect(row).toHaveAttribute("data-expanded", "false");
      await expect(projectChevron).toHaveCount(0);
      await row.press("Enter");
      await expect(row).toHaveAttribute("data-expanded", "true");
      await expect(projectChevron).toHaveCount(0);
      await expect(
        project.getByRole("button", { name: "Set icon for workspace" }),
      ).toHaveText("");
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
    } finally {
      await fixture.close();
    }
  });

for (const width of [1440, 760, 390])
  test(`navigation collapse and background session activity at ${width}`, async ({
    page,
  }) => {
    const fixture = await browserHost();
    try {
      const second = await fixture.execute("session.create", {
        workspaceId: fixture.workspaceId,
        runtimeId: fixture.runtime.id,
        name: "Background",
      });
      await page.setViewportSize({ width, height: 900 });
      await fixture.login(page);
      const open = page.getByRole("button", {
        name: "Open navigation",
        exact: true,
      });
      const show = async () => {
        if (await open.isVisible()) await open.click();
      };
      await show();
      await page
        .locator(".brand")
        .getByRole("button", { name: "Close navigation" })
        .click();
      await expect(open).toBeVisible();
      await expect(
        page.getByRole("button", { name: "New session", exact: true }),
      ).not.toBeVisible();
      if (width === 1440) {
        await page.reload();
        await expect(open).toBeVisible();
      }
      await show();
      const background = page.locator(".session-item").filter({
        has: page.getByRole("button", { name: "Background", exact: true }),
      });
      const asset = fixture.host.store.put("asset", {
        id: crypto.randomUUID(),
        sha256: "fixture",
        kind: "icon",
        mime: "image/png",
        bytes: 0,
        relativePath: "unused",
        name: "Synthetic",
      });
      // A custom icon must never suppress the separate activity indicator.
      const saved = fixture.host.store.get("session", second.id);
      fixture.host.store.patch("session", second.id, saved.revision, {
        iconId: asset.id,
      });
      for (const phase of ["idle", "failed", "interrupted"]) {
        fixture.host.publish(`session:${second.id}`, "run.state", {
          phase: "running",
        });
        const activity = background.locator(".session-activity");
        await expect(activity).toBeVisible();
        await expect(activity.locator("i")).toHaveCount(4);
        await expect(background.locator(".session-icon")).toHaveCount(1);
        expect(
          await activity.evaluate((el) => getComputedStyle(el).animationName),
        ).toBe("session-square-shift");
        expect(
          await activity
            .locator("i")
            .first()
            .evaluate((el) => ({
              radius: getComputedStyle(el).borderRadius,
              smear: getComputedStyle(el).animationName,
            })),
        ).toEqual({ radius: "1.5px", smear: "session-square-smear" });
        fixture.host.publish(`session:${second.id}`, "run.state", { phase });
        await expect(background.locator(".session-activity")).toHaveCount(0);
      }
      fixture.host.publish(`session:${second.id}`, "run.state", {
        phase: "running",
      });
      await expect(background.locator(".session-activity")).toBeVisible();
      await page.reload();
      await show();
      await expect(background.locator(".session-activity")).toBeVisible();
      fixture.host.publish(`session:${second.id}`, "run.state", {
        phase: "idle",
        outcome: "aborted",
      });
      await expect(background.locator(".session-activity")).toHaveCount(0);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
    } finally {
      await fixture.close();
    }
  });

test("sidebar expands past the old limit and shows the complete session name", async ({
  page,
}) => {
  const fixture = await browserHost();
  try {
    const longName =
      "A complete session title with architecture notes, verification evidence, and follow-up work";
    await fixture.execute(
      "session.rename",
      { name: longName },
      fixture.session.id,
      fixture.host.store.get("session", fixture.session.id).revision,
    );
    await page.setViewportSize({ width: 1440, height: 900 });
    await fixture.login(page);
    const separator = page.getByRole("separator", { name: "Resize sidebar" });
    await expect(separator).toHaveAttribute("aria-valuemax", "520");
    const grip = (await separator.boundingBox())!;
    await page.mouse.move(grip.x + grip.width / 2, grip.y + 120);
    await page.mouse.down();
    await page.mouse.move(700, grip.y + 120, { steps: 8 });
    await page.mouse.up();
    await expect
      .poll(() =>
        page
          .getByRole("complementary", { name: "Projects and sessions" })
          .evaluate((element) => element.getBoundingClientRect().width),
      )
      .toBe(520);
    await page.getByRole("button", { name: longName, exact: true }).hover();
    await expect(page.getByRole("tooltip").locator("strong")).toHaveText(
      longName,
    );
    await page.reload();
    await expect
      .poll(() =>
        page
          .getByRole("complementary", { name: "Projects and sessions" })
          .evaluate((element) => element.getBoundingClientRect().width),
      )
      .toBe(520);
  } finally {
    await fixture.close();
  }
});
