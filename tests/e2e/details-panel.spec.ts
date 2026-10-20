import { test, expect } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { browserHost } from "../support/browser-host.js";

const exec = promisify(execFile);

for (const width of [1440, 760, 390])
  test(`details files resize expand and real PTY at ${width}`, async ({
    page,
    browserName,
  }, testInfo) => {
    test.setTimeout(90000);
    const fixture = await browserHost();
    try {
      await mkdir(join(fixture.workspace, "folder"));
      await writeFile(join(fixture.workspace, "folder", "child.txt"), "child");
      await writeFile(
        join(fixture.workspace, "README.md"),
        "# Workspace document\n\nA **readable** document.\n\n" +
          "Long paragraph.\n\n".repeat(80),
      );
      for (const name of ["app.ts", "package.json", "image.png", "config.yaml"])
        await writeFile(join(fixture.workspace, name), "fixture");
      await page.setViewportSize({ width, height: 900 });
      await fixture.login(page);
      const editor = page.getByRole("textbox", { name: "Message Pi" });
      await expect(editor).toBeEnabled();
      await page
        .getByRole("button", { name: "Open workspace details" })
        .click();
      const details = page.getByRole("complementary", {
        name: "Workspace details",
      });
      const tree = details.getByRole("tree");
      const folder = tree.getByRole("treeitem", { name: /folder/ });
      await expect(
        folder.locator(".file-type-icon.directory svg"),
      ).toBeVisible();
      await folder.focus();
      await folder.press("ArrowRight");
      await expect(
        tree.getByRole("treeitem", { name: "child.txt", exact: true }),
      ).toBeVisible();
      await folder.press("ArrowDown");
      await expect(
        tree.getByRole("treeitem", { name: "child.txt", exact: true }),
      ).toBeFocused();
      await page.keyboard.press("ArrowLeft");
      await expect(folder).toBeFocused();
      for (const kind of ["markdown", "typescript", "node", "image", "yaml"])
        await expect(tree.locator(`.file-type-icon.${kind}`)).toBeVisible();
      await expect(
        tree.locator(".file-type-icon.typescript > svg"),
      ).toBeVisible();
      await expect(tree.locator(".file-type-icon.node > svg")).toBeVisible();
      await tree
        .getByRole("treeitem", { name: "README.md", exact: true })
        .click();
      await expect(
        details.getByRole("heading", { name: "Workspace document" }),
      ).toBeVisible();
      await expect(details.locator(".file-document strong")).toHaveCSS(
        "display",
        "inline",
      );
      await details
        .getByRole("button", { name: "Source", exact: true })
        .click();
      await expect(details.locator(".file-source")).toContainText(
        "# Workspace document",
      );
      await details
        .getByRole("button", { name: "Document", exact: true })
        .click();
      const separator = details.getByRole("separator", {
        name: "Resize workspace details",
      });
      await separator.focus();
      if (width === 1440) {
        await separator.hover({ position: { x: 4, y: 100 } });
        await expect
          .poll(() =>
            separator.evaluate((element) => {
              const line = getComputedStyle(element, "::after");
              return { width: line.width, color: line.backgroundColor };
            }),
          )
          .toEqual({ width: "1px", color: "rgb(76, 99, 194)" });
      }
      await separator.press("ArrowRight");
      if (width === 1440) {
        const grip = (await separator.boundingBox())!;
        await page.mouse.move(grip.x + grip.width / 2, grip.y + 100);
        await page.mouse.down();
        await page.mouse.move(grip.x - 80, grip.y + 100, { steps: 5 });
        await page.mouse.up();
      }
      const saved = await details.evaluate(
        (element) => element.getBoundingClientRect().width,
      );
      await page.reload();
      await expect(details).toBeVisible();
      await expect
        .poll(() =>
          details.evaluate((element) => element.getBoundingClientRect().width),
        )
        .toBeCloseTo(saved, 0);
      await editor.focus();
      await editor.press("Control+Shift+E");
      await expect(details).not.toHaveClass(/expanded/);
      const expand = details.getByRole("button", {
        name: "Expand details",
        exact: true,
      });
      await expect(expand).toHaveAttribute("title", /Shift E/);
      await expand.focus();
      await expand.press("Control+Shift+E");
      await expect(details).toHaveClass(/expanded/);
      expect(
        await details.evaluate(
          (element) => element.getBoundingClientRect().width,
        ),
      ).toBe(width);
      await details
        .getByRole("button", { name: "Restore details size" })
        .click();
      expect(
        await details.evaluate(
          (element) => element.getBoundingClientRect().width,
        ),
      ).toBeCloseTo(saved, 0);
      await details.getByRole("tab", { name: "Terminal", exact: true }).click();
      const terminal = details.getByRole("region", {
        name: "Workspace terminal",
      });
      await expect(
        terminal.locator('.terminal-session[aria-label$="Running"]'),
      ).toBeVisible();
      const terminalTab = terminal.getByRole("tab", {
        name: "zsh",
        exact: true,
      });
      const terminalTabWrap = terminal.locator(".terminal-tab-wrap").first();
      const terminalTabActions = terminalTabWrap.locator(
        ".terminal-tab-actions",
      );
      const normalTabBox = await terminalTab.boundingBox();
      const normalWrapBox = await terminalTabWrap.boundingBox();
      expect(normalTabBox?.width).toBeLessThan(130);
      expect(normalTabBox?.height).toBe(29);
      expect(normalWrapBox?.width).toBe((normalTabBox?.width ?? 0) + 4);
      await expect(terminalTab).toHaveCSS("text-align", "left");
      await expect(terminalTabActions).toHaveCSS("opacity", "0");
      await terminalTabWrap.hover();
      await expect(terminalTabActions).toHaveCSS("opacity", "1");
      await expect(
        terminal.getByRole("button", { name: "Restart zsh" }),
      ).toBeVisible();
      await expect(
        terminal.getByRole("button", { name: "Close zsh" }),
      ).toBeVisible();
      const [hoverTabBox, hoverWrapBox] = await Promise.all([
        terminalTab.boundingBox(),
        terminalTabWrap.boundingBox(),
      ]);
      expect(hoverTabBox).toEqual(normalTabBox);
      expect(hoverWrapBox).toEqual(normalWrapBox);
      const closeBox = await terminal
        .getByRole("button", { name: "Close zsh" })
        .boundingBox();
      expect(closeBox?.x).toBeGreaterThanOrEqual(
        (hoverTabBox?.x ?? 0) + (hoverTabBox?.width ?? 0) - 28,
      );
      await page.mouse.move(0, 0);
      await terminal.getByRole("button", { name: "Restart zsh" }).focus();
      await expect(terminalTabActions).toHaveCSS("opacity", "1");
      if (width === 1440 || width === 390)
        await page.screenshot({
          path: join(
            process.cwd(),
            ".suri-local",
            "diagnostics",
            `details-panel-${browserName}-${width}.png`,
          ),
        });
      const input = terminal.locator(".xterm-helper-textarea");
      await input.focus();
      await input.press("Control+Shift+E");
      await expect(details).not.toHaveClass(/expanded/);
      await input.press("Control+U");
      await input.pressSequentially("printf 'DETAILS_PTY_OK\\n'");
      await input.press("Enter");
      await expect(terminal.locator(".xterm-accessibility-tree")).toContainText(
        "DETAILS_PTY_OK",
      );
      const initialScreen = await terminal
        .locator(".xterm-screen")
        .boundingBox();
      await details
        .getByRole("button", { name: "Expand details", exact: true })
        .click();
      await expect
        .poll(
          async () =>
            (await terminal.locator(".xterm-screen").boundingBox())!.width,
        )
        .toBeGreaterThan(initialScreen!.width);
      const colors = await terminal.evaluate((element) =>
        [
          element.querySelector(".terminal"),
          element.querySelector(".xterm-viewport"),
        ].map((el) => getComputedStyle(el!).backgroundColor),
      );
      expect(colors).toEqual(["rgb(247, 248, 251)", "rgb(247, 248, 251)"]);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      ).toBe(true);
      await page.screenshot({
        path: testInfo.outputPath(`details-terminal-${width}.png`),
      });
      await details
        .getByRole("button", { name: "Restore details size" })
        .click();
      await expect
        .poll(
          async () =>
            (await terminal.locator(".xterm-screen").boundingBox())!.width,
        )
        .toBeCloseTo(initialScreen!.width, 0);
      if (width === 1440) {
        await terminal
          .getByRole("button", { name: "Split terminal right" })
          .click();
        await expect(terminal.locator(".terminal-session")).toHaveCount(2);
        const divider = terminal.getByRole("separator", {
          name: "Resize terminal panes",
        });
        await divider.focus();
        await divider.press("ArrowRight");
        await terminal.getByRole("button", { name: "New terminal" }).click();
        await expect(
          terminal.locator('[role="tab"][aria-selected="true"]'),
        ).toHaveText("zsh");
        await expect(terminal.locator(".terminal-session")).toHaveCount(3);
      }
      await details.getByRole("tab", { name: "Files", exact: true }).click();
      await tree
        .getByRole("treeitem", { name: "README.md", exact: true })
        .click();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      ).toBe(true);
      await expect(
        details.getByRole("heading", { name: "Workspace document" }),
      ).toBeVisible();
      await page.screenshot({
        path: testInfo.outputPath(`details-files-${width}.png`),
      });
      if (width === 1440) {
        await separator.focus();
        for (let step = 0; step < 50; step++)
          await separator.press("ArrowLeft");
        expect(
          await page
            .locator("main")
            .evaluate((element) => element.getBoundingClientRect().width),
        ).toBeGreaterThanOrEqual(320);
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= window.innerWidth,
          ),
        ).toBe(true);
        const desktopWidth = await details.evaluate(
          (element) => element.getBoundingClientRect().width,
        );
        const navigation = page.getByRole("complementary", {
          name: "Projects and sessions",
        });
        const desktopNavigationWidth = await navigation.evaluate(
          (element) => element.getBoundingClientRect().width,
        );
        await page.setViewportSize({ width: 390, height: 900 });
        await expect
          .poll(() =>
            details.evaluate(
              (element) => element.getBoundingClientRect().width,
            ),
          )
          .toBeLessThanOrEqual(390);
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= window.innerWidth,
          ),
        ).toBe(true);
        await page.setViewportSize({ width: 1440, height: 900 });
        await expect
          .poll(() =>
            navigation.evaluate(
              (element) => element.getBoundingClientRect().width,
            ),
          )
          .toBeCloseTo(desktopNavigationWidth, 0);
        await expect
          .poll(() =>
            details.evaluate(
              (element) => element.getBoundingClientRect().width,
            ),
          )
          .toBeCloseTo(desktopWidth, 0);
        await navigation
          .getByRole("button", { name: "Close navigation", exact: true })
          .click();
        await expect(navigation).toBeHidden();
        await expect(separator).toHaveAttribute("aria-valuemax", "1112");
        for (let step = 0; step < 50; step++)
          await separator.press("ArrowLeft");
        await expect
          .poll(() =>
            details.evaluate(
              (element) => element.getBoundingClientRect().width,
            ),
          )
          .toBeCloseTo(1112, 0);
        await page
          .getByRole("button", { name: "Open navigation", exact: true })
          .click();
        await expect(navigation).toBeVisible();
        await expect
          .poll(() =>
            page
              .locator("main")
              .evaluate((element) => element.getBoundingClientRect().width),
          )
          .toBeGreaterThanOrEqual(320);
        await expect
          .poll(() =>
            details.evaluate(
              (element) => element.getBoundingClientRect().width,
            ),
          )
          .toBeCloseTo(desktopWidth, 0);
        await details
          .getByRole("button", { name: "Expand details", exact: true })
          .click();
        const layout = await details
          .locator(".file-browser")
          .evaluate((element) => getComputedStyle(element).flexDirection);
        expect(layout).toBe("row-reverse");
        await page.screenshot({
          path: testInfo.outputPath("details-files-expanded.png"),
        });
      } else {
        const navigationToggle = page.getByRole("button", {
          name: "Open navigation",
          exact: true,
        });
        await navigationToggle.focus();
        await navigationToggle.press("Enter");
        const navigation = page.getByRole("complementary", {
          name: "Projects and sessions",
        });
        const closeNavigation = navigation.getByRole("button", {
          name: "Close navigation",
          exact: true,
        });
        await expect(navigation).toBeVisible();
        await closeNavigation.evaluate((element) => {
          (element as HTMLElement).focus();
          window.dispatchEvent(
            new KeyboardEvent("keydown", {
              key: "e",
              code: "KeyE",
              ctrlKey: true,
              shiftKey: true,
              bubbles: true,
              cancelable: true,
            }),
          );
        });
        await expect(details).toHaveClass(/expanded/);
        expect(
          await page.evaluate(() =>
            Boolean(
              document
                .elementFromPoint(20, 130)
                ?.closest(".workspace-details.expanded"),
            ),
          ),
        ).toBe(true);
        await details
          .getByRole("button", { name: "Restore details size", exact: true })
          .click();
        await expect(navigation).toBeVisible();
        await expect(navigation).not.toHaveAttribute("inert", "");
        await expect(closeNavigation).toBeFocused();
        await closeNavigation.click();
      }
    } finally {
      await fixture.close();
    }
  });

test("assistant file links open a focused changes review and file menu", async ({
  page,
}, testInfo) => {
  const fixture = await browserHost();
  try {
    await exec("/usr/bin/git", ["-C", fixture.workspace, "init"]);
    await exec("/usr/bin/git", ["-C", fixture.workspace, "add", "hello.txt"]);
    await exec("/usr/bin/git", [
      "-C",
      fixture.workspace,
      "-c",
      "user.name=Suri Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "-m",
      "fixture",
    ]);
    await writeFile(
      join(fixture.workspace, "hello.txt"),
      "first line\nchanged second line\n",
    );
    await writeFile(
      join(fixture.workspace, "new file.ts"),
      "export const value = 1;\n",
    );
    await page.setViewportSize({ width: 1440, height: 900 });
    if (testInfo.project.name === "chromium")
      await page
        .context()
        .grantPermissions(["clipboard-read", "clipboard-write"], {
          origin: fixture.host.origin,
        });
    await fixture.login(page);
    await expect(
      page.getByRole("textbox", { name: "Message Pi" }),
    ).toBeEnabled();
    const messageId = crypto.randomUUID();
    const callId = crypto.randomUUID();
    fixture.host.publish(`session:${fixture.session.id}`, "tool.state", {
      callId,
      name: "edit",
      phase: "completed",
      arguments: { path: join(fixture.workspace, "hello.txt") },
      blocks: [],
    });
    fixture.host.publish(`session:${fixture.session.id}`, "message.upsert", {
      messageId,
      role: "assistant",
      revision: 1,
      final: true,
      blocks: [
        {
          id: crypto.randomUUID(),
          kind: "toolCall",
          callId,
          name: "edit",
          arguments: { path: join(fixture.workspace, "hello.txt") },
        },
        {
          id: crypto.randomUUID(),
          kind: "text",
          text: "Updated the workspace file.",
        },
      ],
    });
    const changed = page.getByRole("button", {
      name: "hello.txt",
      exact: true,
    });
    await expect(page.getByLabel("Files changed")).toBeVisible();
    await changed.click();
    const details = page.getByRole("complementary", {
      name: "Workspace details",
    });
    await expect(details).toBeVisible();
    await expect(
      details.getByRole("tab", { name: "Changes", exact: true }),
    ).toHaveAttribute("aria-selected", "true");
    await expect(details.getByLabel("Changes in hello.txt")).toContainText(
      "changed second line",
    );
    const added = details.getByRole("option", { name: /new file\.ts/ });
    await expect(added).toBeVisible();
    await added.click();
    await expect(details.getByLabel("Changes in new file.ts")).toContainText(
      "export const value = 1",
    );
    await page.screenshot({ path: testInfo.outputPath("changes-desktop.png") });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect
      .poll(() =>
        details.evaluate((element) => element.getBoundingClientRect().width),
      )
      .toBeLessThanOrEqual(390);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await expect(details.getByLabel("Changes in new file.ts")).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("changes-narrow.png") });
    await page.setViewportSize({ width: 1440, height: 900 });
    await changed.click({ button: "right" });
    const menu = page.getByRole("menu", { name: "Actions for hello.txt" });
    await expect(menu).toBeVisible();
    for (const action of [
      "Preview",
      "Review changes",
      "Open",
      "Open With…",
      "Copy file contents",
      "Copy path",
      "Reveal in Finder",
    ])
      await expect(
        menu.getByRole("menuitem", { name: action, exact: true }),
      ).toBeVisible();
    await menu
      .getByRole("menuitem", { name: "Copy file contents", exact: true })
      .click();
    await expect(menu.getByRole("status")).toHaveText("File contents copied.");
    if (testInfo.project.name === "chromium")
      expect(
        await page.evaluate(() => navigator.clipboard.readText()),
      ).toContain("changed second line");
    await menu.getByRole("menuitem", { name: "Open", exact: true }).click();
    await expect(
      details.getByRole("tab", { name: "Files", exact: true }),
    ).toHaveAttribute("aria-selected", "true");
    await expect(details.getByLabel("Preview hello.txt")).toBeVisible();
    await details.getByRole("treeitem", { name: "new file.ts" }).click();
    const filePreview = details.getByLabel("Preview new file.ts");
    await expect(filePreview).toBeVisible();
    await expect
      .poll(() => filePreview.locator(".file-source span[style]").count())
      .toBeGreaterThan(0);
    await filePreview.getByRole("button", { name: "Edit" }).click();
    const editor = filePreview.getByRole("textbox", {
      name: "Edit new file.ts",
    });
    await editor.fill("export const value = 2;\n");
    await expect
      .poll(() =>
        filePreview.locator(".highlighted-textarea pre span[style]").count(),
      )
      .toBeGreaterThan(2);
    expect(
      await filePreview
        .locator(".highlighted-textarea pre span[style]")
        .evaluateAll(
          (tokens) =>
            new Set(tokens.map((token) => getComputedStyle(token).color)).size,
        ),
    ).toBeGreaterThan(1);
    await filePreview
      .getByRole("button", { name: "Save", exact: true })
      .click();
    await expect(
      filePreview.getByText("Saved.", { exact: true }),
    ).toBeVisible();
    await expect(filePreview).toContainText("value = 2");
  } finally {
    await fixture.close();
  }
});
