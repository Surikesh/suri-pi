import { test, expect } from "@playwright/test";
import { readFile, writeFile, unlink, symlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { browserHost } from "../support/browser-host.js";

const pngBase64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";

test("cold session keeps built-in slash commands and can explicitly load Pi commands", async ({
  page,
}) => {
  const fixture = await browserHost();
  try {
    await fixture.login(page);
    await expect(page.getByText("Connected", { exact: true })).toBeVisible();
    // Opening a session prefetches models, which resumes its runtime. Reap the
    // idle runtime to get back to the cold session this test is about.
    await expect.poll(() => fixture.host.children.size).toBe(1);
    await expect(page.locator(".run-status")).toContainText("idle");
    fixture.host.reapIdleRuntimes(Date.now() + 16 * 60_000);
    await expect.poll(() => fixture.host.children.size).toBe(0);
    const editor = page.getByRole("textbox", { name: "Message Pi" });
    await editor.fill("/com");
    const slash = page.getByRole("listbox", { name: "Slash commands" });
    await expect(slash).toContainText("/compact");
    expect(fixture.host.children.size).toBe(0);
    expect(
      (await fixture.execute("commands.list", {}, fixture.session.id))
        .runtimeAvailable,
    ).toBe(false);
    await expect(slash).toContainText("Resume session to load Pi commands");
    await expect(page.getByRole("alert")).toHaveCount(0);
    await expect.poll(() => fixture.host.children.size).toBe(0);
    await slash
      .getByRole("button", { name: "Resume session to load Pi commands" })
      .click();
    await editor.fill("/");
    await expect(slash).toContainText("Synthetic immediate extension");
    await expect.poll(() => fixture.host.children.size).toBe(1);
    await editor.fill("/compact");
    await expect(slash).toContainText("/compact");
    await editor.press("Enter");
    await expect(editor).toHaveValue("");
    await expect(page.locator(".run-status")).toContainText("idle");
    fixture.host.reapIdleRuntimes(Date.now() + 16 * 60_000);
    await expect.poll(() => fixture.host.children.size).toBe(0);
    await editor.fill("/com");
    await expect(slash).toContainText("Resume session to load Pi commands");
    await page.reload();
    await expect(page.getByText("Connected", { exact: true })).toBeVisible();
    // Reload prefetches models again, which resumes the runtime, so Pi commands
    // load without an explicit resume.
    await expect.poll(() => fixture.host.children.size).toBe(1);
    await editor.fill("/");
    await expect(slash).toContainText("Synthetic immediate extension");
    await expect(page.getByRole("alert")).toHaveCount(0);
  } finally {
    await fixture.close();
  }
});

test("native shell is asked to renew an expired local session", async ({
  page,
}) => {
  const fixture = await browserHost();
  try {
    await fixture.login(page);
    await page.addInitScript(() => {
      (window as any).__nativeMessages = [];
      window.webkit = {
        messageHandlers: {
          suri: {
            postMessage: (message) =>
              (window as any).__nativeMessages.push(message),
          },
        },
      };
    });
    await page.route("**/v1/client", async (route) => {
      await route.fulfill({
        status: 401,
        contentType: "application/json",
        body: JSON.stringify({
          v: 1,
          id: "",
          status: "rejected",
          error: {
            code: "UNAUTHORIZED",
            message: "Open Suri through its native app or local CLI.",
            retryable: false,
          },
        }),
      });
    });
    await page.reload();
    await expect
      .poll(() => page.evaluate(() => (window as any).__nativeMessages))
      .toEqual([{ type: "reauthenticate" }]);
  } finally {
    await fixture.close();
  }
});

test("native shell is asked to recover when the local host disappears", async ({
  page,
}) => {
  const fixture = await browserHost();
  try {
    await fixture.login(page);
    await page.evaluate(() => {
      (window as any).__nativeMessages = [];
      window.webkit = {
        messageHandlers: {
          suri: {
            postMessage: (message) =>
              (window as any).__nativeMessages.push(message),
          },
        },
      };
    });
    await fixture.host.close();
    await expect
      .poll(() => page.evaluate(() => (window as any).__nativeMessages))
      .toEqual([{ type: "reauthenticate" }]);
  } finally {
    await fixture.close();
  }
});

test("an expired command session renews through the native shell without showing an error", async ({
  page,
}) => {
  const fixture = await browserHost();
  try {
    await fixture.login(page);
    await page.evaluate(() => {
      (window as any).__nativeMessages = [];
      window.webkit = {
        messageHandlers: {
          suri: {
            postMessage: (message) =>
              (window as any).__nativeMessages.push(message),
          },
        },
      };
    });
    await page.route("**/v1/commands", async (route) => {
      await route.fulfill({
        status: 401,
        contentType: "application/json",
        body: JSON.stringify({
          v: 1,
          id: "",
          status: "rejected",
          error: {
            code: "UNAUTHORIZED",
            message: "Open Suri through its native app or local CLI.",
            retryable: false,
          },
        }),
      });
    });
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByLabel("Text size").selectOption("2");
    await expect
      .poll(() => page.evaluate(() => (window as any).__nativeMessages))
      .toEqual([{ type: "reauthenticate" }]);
    await expect(page.getByRole("alert")).toHaveCount(0);
  } finally {
    await fixture.close();
  }
});

test("authenticated HTTP activity renews the local session cookie", async ({
  page,
}) => {
  const fixture = await browserHost();
  try {
    await fixture.login(page);
    const cookies = await page.context().cookies(fixture.host.origin);
    const response = await fetch(`${fixture.host.origin}/v1/client`, {
      headers: {
        Cookie: cookies.map(({ name, value }) => `${name}=${value}`).join("; "),
      },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toContain("Max-Age=28800");
  } finally {
    await fixture.close();
  }
});

test("Reload UI delegates the complete operation to the native shell", async ({
  page,
}) => {
  const fixture = await browserHost();
  try {
    await page.addInitScript(() => {
      (window as any).__nativeMessages = [];
      window.webkit = {
        messageHandlers: {
          suri: {
            postMessage: (message) =>
              (window as any).__nativeMessages.push(message),
          },
        },
      };
    });
    await fixture.login(page);
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("button", { name: "Reload UI", exact: true }).click();
    await expect
      .poll(() => page.evaluate(() => (window as any).__nativeMessages))
      .toEqual([{ type: "reload" }]);
    await expect(page.getByRole("alert")).toHaveCount(0);
  } finally {
    await fixture.close();
  }
});

test("dropping a Raycast-style file attaches it instead of navigating", async ({
  page,
}) => {
  const fixture = await browserHost();
  try {
    await fixture.login(page);
    const prevented = await page.locator(".shell").evaluate((element) => {
      const transfer = new DataTransfer();
      transfer.items.add(
        new File(["Raycast attachment"], "raycast-note.txt", {
          type: "text/plain",
        }),
      );
      return !element.dispatchEvent(
        new DragEvent("drop", {
          bubbles: true,
          cancelable: true,
          dataTransfer: transfer,
        }),
      );
    });
    expect(prevented).toBe(true);
    await expect(
      page.getByText("raycast-note.txt", { exact: true }),
    ).toBeVisible();
    await expect(page).not.toHaveURL(/^file:/);
  } finally {
    await fixture.close();
  }
});

test("pasting a screenshot attaches it and preserves mixed clipboard text", async ({
  page,
}, testInfo) => {
  const fixture = await browserHost();
  try {
    await fixture.login(page);
    const editor = page.getByRole("textbox", { name: "Message Pi" });
    await editor.fill("Before ");
    await editor.evaluate((element, encoded) => {
      const bytes = Uint8Array.from(atob(encoded), (value) =>
        value.charCodeAt(0),
      );
      const image = new File([bytes], "Screenshot.png", { type: "image/png" });
      const clipboard = new DataTransfer();
      clipboard.items.add(image);
      clipboard.setData("text/plain", "inspect this");
      element.dispatchEvent(
        new ClipboardEvent("paste", {
          bubbles: true,
          cancelable: true,
          clipboardData: clipboard,
        }),
      );
    }, pngBase64);
    await expect(editor).toHaveValue("Before inspect this");
    await expect(
      page.getByRole("img", { name: "Screenshot.png" }),
    ).toBeVisible();
    const tile = page.locator(".attachment-card.image");
    const tileBox = await tile.boundingBox();
    expect(tileBox?.width).toBe(64);
    expect(tileBox?.height).toBe(64);
    const previewButton = page.getByRole("button", {
      name: "Preview Screenshot.png",
    });
    if (testInfo.project.name === "chromium")
      await page.screenshot({
        path: testInfo.outputPath("attachment-tile.png"),
      });
    await previewButton.click();
    const preview = page.getByRole("dialog", {
      name: "Preview Screenshot.png",
    });
    await expect(
      preview.getByRole("img", { name: "Screenshot.png" }),
    ).toBeVisible();
    if (testInfo.project.name === "chromium")
      await page.screenshot({
        path: testInfo.outputPath("attachment-lightbox.png"),
      });
    await page.keyboard.press("Escape");
    await expect(preview).toHaveCount(0);
    await expect(previewButton).toBeFocused();
    await expect(
      page.getByRole("button", { name: "Remove Screenshot.png" }),
    ).toBeVisible();
  } finally {
    await fixture.close();
  }
});

for (const width of [1440, 390])
  test(`composer grows with text without a visible scrollbar track at ${width}`, async ({
    page,
  }, testInfo) => {
    const fixture = await browserHost();
    try {
      await page.setViewportSize({ width, height: 900 });
      await fixture.login(page);
      const editor = page.getByRole("textbox", { name: "Message Pi" });
      const initialHeight = await editor.evaluate(
        (element) => element.getBoundingClientRect().height,
      );
      await editor.fill(
        Array.from({ length: 12 }, (_, index) => `Line ${index + 1}`).join(
          "\n",
        ),
      );
      await expect
        .poll(() =>
          editor.evaluate((element) => element.getBoundingClientRect().height),
        )
        .toBeGreaterThan(initialHeight);
      const metrics = await editor.evaluate((element) => {
        const style = getComputedStyle(element);
        const composer = element.closest(".composer-rail")!;
        const conversation = element.closest(".conversation")!;
        return {
          height: element.getBoundingClientRect().height,
          maxHeight: Number.parseFloat(style.maxHeight),
          scrollbarWidth: style.scrollbarWidth,
          composerHeight: composer.getBoundingClientRect().height,
          clearance: Number.parseFloat(
            getComputedStyle(conversation).getPropertyValue(
              "--composer-clearance",
            ),
          ),
        };
      });
      expect(metrics.height).toBeLessThanOrEqual(metrics.maxHeight + 1);
      expect(metrics.maxHeight).toBeLessThanOrEqual(initialHeight * 2 + 1);
      expect(metrics.scrollbarWidth).toBe("none");
      expect(metrics.clearance).toBeGreaterThan(metrics.composerHeight);
      await expect(
        page.getByRole("button", { name: "Send message" }),
      ).toBeVisible();
      if (testInfo.project.name === "chromium")
        await page.screenshot({
          path: testInfo.outputPath(`composer-${width}.png`),
        });
    } finally {
      await fixture.close();
    }
  });

for (const width of [1440, 390])
  test(`real host composer slash context files PTY and import at ${width}`, async ({
    page,
  }, testInfo) => {
    test.setTimeout(90000);
    const fixture = await browserHost();
    try {
      await page.setViewportSize({ width, height: 900 });
      await fixture.login(page);
      const editor = page.getByRole("textbox", { name: "Message Pi" });
      await expect(editor).toBeEnabled();
      // Start a real adapter subprocess containing only the synthetic external Pi boundary.
      await editor.fill("Hello synthetic Pi");
      await expect(editor).toHaveValue("Hello synthetic Pi");
      await expect(
        page.getByRole("button", { name: "Send message", exact: true }),
      ).toBeEnabled();
      await editor.press("Enter");
      await expect(
        page.getByRole("button", { name: "Open hello.txt:2", exact: true }),
      ).toBeVisible();
      await page
        .getByRole("button", { name: "Open hello.txt:2", exact: true })
        .click();
      const preview = page.getByRole("dialog", { name: "Preview hello.txt" });
      await expect(preview).toContainText("second line");
      await expect(preview.locator('[data-line="2"]')).toHaveClass(/selected/);
      const previewBox = await preview.boundingBox();
      expect(previewBox?.width).toBeGreaterThan(width === 1440 ? 900 : 340);
      expect(
        await preview.evaluate((element) =>
          Number.parseFloat(getComputedStyle(element).borderTopRightRadius),
        ),
      ).toBeGreaterThan(10);
      await preview.getByRole("button", { name: "Edit", exact: true }).click();
      const fileEditor = preview.getByRole("textbox", {
        name: "Edit hello.txt",
      });
      await fileEditor.fill("corrected first line\nsecond line\n");
      await page.screenshot({
        path: testInfo.outputPath(`file-editor-${width}.png`),
        fullPage: true,
      });
      for (const action of ["Open", "Open With…", "Reveal in Finder"])
        await expect(
          preview.getByRole("button", { name: action, exact: true }),
        ).toBeEnabled();
      await preview.getByRole("button", { name: "Close", exact: true }).click();
      await expect(preview).toBeVisible();
      await expect(
        preview.getByText("Save or cancel your changes before closing."),
      ).toBeVisible();
      await fileEditor.press("Meta+s");
      await expect(
        preview.getByText("Saved to the workspace file."),
      ).toBeVisible();
      await expect
        .poll(() => readFile(join(fixture.workspace, "hello.txt"), "utf8"))
        .toBe("corrected first line\nsecond line\n");
      const download = page.waitForEvent("download");
      await preview.getByRole("button", { name: "Save a Copy" }).click();
      expect((await download).suggestedFilename()).toBe("hello.txt");
      await page.keyboard.press("Escape");
      await expect(preview).toHaveCount(0);
      await expect(
        page.getByRole("button", { name: "Model", exact: true }),
      ).toContainText("fixture-model");
      await page.getByRole("button", { name: "Model", exact: true }).click();
      await page.getByRole("button", { name: "Show all models" }).click();
      await page.getByRole("option", { name: "synthetic · Alternate" }).click();
      await expect(
        page.getByRole("button", { name: "Model", exact: true }),
      ).toContainText("alternate");
      await page.getByRole("button", { name: "Model", exact: true }).click();
      await page.getByRole("button", { name: "Show all models" }).click();
      await page.getByRole("option", { name: "synthetic · Rejected" }).click();
      await expect(page.getByRole("alert")).toContainText("rejected");
      await expect(
        page.getByRole("button", { name: "Model", exact: true }),
      ).toContainText("alternate");
      await page.getByRole("button", { name: "Thinking level" }).click();
      await page.getByRole("option", { name: "high", exact: true }).click();
      await expect(
        page.getByRole("button", { name: "Thinking level" }),
      ).toContainText("high");
      await editor.fill("@hello");
      await expect(
        page.getByRole("option", { name: "hello.txt", exact: true }),
      ).toBeVisible();
      await editor.press("Enter");
      await expect(
        page.getByRole("button", { name: "Remove hello.txt" }),
      ).toBeVisible();
      await editor.fill("REJECT keep attachment");
      await editor.press("Enter");
      await expect(editor).toHaveValue("REJECT keep attachment");
      await expect(
        page.getByRole("button", { name: "Remove hello.txt" }),
      ).toBeVisible();
      await page.reload();
      await expect(editor).toHaveValue("REJECT keep attachment");
      await expect(
        page.getByRole("button", { name: "Remove hello.txt" }),
      ).toBeVisible();
      if (width < 900)
        await page.getByRole("button", { name: "Open navigation" }).click();
      await page
        .getByRole("button", { name: "New session ⌃⌥N", exact: true })
        .click();
      await page
        .getByRole("dialog", { name: "New session" })
        .getByRole("button", { name: "Create session" })
        .click();
      await expect(
        page.getByRole("button", { name: "Rename current session" }),
      ).toContainText("New session");
      await expect(
        page.getByRole("button", { name: "Remove hello.txt" }),
      ).toHaveCount(0);
      await expect(editor).toHaveValue("");
      await expect(
        page.getByRole("button", { name: "Model", exact: true }),
      ).toContainText("alternate");
      await editor.fill("Other session draft");
      if (width < 900)
        await page.getByRole("button", { name: "Open navigation" }).click();
      await page
        .getByRole("button", { name: "Browser fixture", exact: true })
        .click();
      await expect(editor).toHaveValue("REJECT keep attachment");
      await expect(
        page.getByRole("button", { name: "Remove hello.txt" }),
      ).toBeVisible();
      await editor.fill("/");
      const slash = page.getByRole("listbox", { name: "Slash commands" });
      await expect(slash).toContainText("Synthetic prompt template");
      await expect(slash).toContainText("Synthetic skill");
      await expect(slash).toContainText("Synthetic immediate extension");
      await editor.press("Escape");
      await expect(slash).toHaveCount(0);
      await editor.fill("/compact keep decisions");
      await editor.press("Enter");
      await expect(editor).toHaveValue("");
      await expect(page.locator(".run-status")).toContainText("idle");
      await expect(
        page.getByRole("combobox", { name: "Delivery mode" }),
      ).toHaveCount(0);
      await editor.fill("/nonexistent");
      await editor.press("Escape");
      await expect(
        page.getByRole("listbox", { name: "Slash commands" }),
      ).toHaveCount(0);
      await expect(editor).toHaveValue("/nonexistent");
      await editor.press("Enter");
      await expect(editor).toHaveValue("/nonexistent");
      await expect(page.getByRole("alert")).toContainText("Unknown command");
      await editor.fill("/login");
      await editor.press("Escape");
      await expect(
        page.getByRole("listbox", { name: "Slash commands" }),
      ).toHaveCount(0);
      await expect(editor).toHaveValue("/login");
      await editor.press("Enter");
      await expect(page.getByRole("alert")).toContainText(
        "manage credentials directly in Pi",
      );
      const calls = (
        await readFile(join(fixture.workspace, "rpc-calls.jsonl"), "utf8")
      )
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(
        calls.some(
          (c) =>
            c.type === "compact" && c.customInstructions === "keep decisions",
        ),
      ).toBe(true);
      expect(
        calls.some(
          (c) => c.type === "prompt" && c.message.includes("/nonexistent"),
        ),
      ).toBe(false);
      expect(
        calls.find((c) => c.type === "prompt" && c.message.includes("REJECT"))
          ?.message,
      ).toContain("second line");
      await editor.fill("persistent per-session draft");
      await fixture.restart(page);
      await expect(editor).toHaveValue("persistent per-session draft");
      await expect(
        page.getByRole("button", { name: "Model", exact: true }),
      ).toContainText("alternate");
      await expect(
        page.getByRole("button", { name: "Thinking level" }),
      ).toContainText("high");
      await page
        .getByRole("button", { name: "Open workspace details" })
        .click();
      await page.getByRole("tab", { name: "Terminal", exact: true }).click();
      const terminal = page.getByRole("region", { name: "Workspace terminal" });
      const terminalSession = terminal.locator(".terminal-session");
      await expect(terminalSession).toHaveAttribute("aria-label", /Running/);
      // The xterm helper textarea is intentionally visually hidden. Input is
      // delivered through focused terminal key events, not Playwright fill().
      await terminal.locator(".xterm-screen").click();
      await terminal.locator(".xterm-helper-textarea").press("Control+U");
      await terminal
        .locator(".xterm-helper-textarea")
        .pressSequentially("printf 'SURI_PTY_OK\\n'");
      await terminal.locator(".xterm-helper-textarea").press("Enter");
      await expect(terminal.locator(".xterm-accessibility-tree")).toContainText(
        "SURI_PTY_OK",
      );
      // Close the isolated PTY through the host boundary; xterm's hidden
      // textarea and shell startup echo are not a deterministic exit signal.
      const terminalId = await page.evaluate((workspaceId) => {
        const layout = JSON.parse(
          sessionStorage.getItem(`suri.terminal-workspace.${workspaceId}`)!,
        );
        return layout.groups[0].panes[0].terminalId as string;
      }, fixture.workspaceId);
      await fixture.execute("terminal.close", { terminalId });
      await expect(terminal).toContainText("Exited");
      await terminal.locator(".terminal-tab-wrap").hover();
      await terminal.getByRole("button", { name: "Restart zsh" }).click();
      await expect(terminalSession).toHaveAttribute("aria-label", /Running/);
      await page.getByRole("button", { name: "Close details" }).click();
      // Browser-uploaded synthetic JSONL -> real preview, copies and SQLite deduplication.
      const histories = ["One", "Two"].map((name) => ({
        name: `${name}.jsonl`,
        mimeType: "application/json",
        buffer: Buffer.from(
          JSON.stringify({
            type: "session",
            version: 3,
            id: randomUUID(),
            cwd: fixture.workspace,
            name,
          }) + "\n",
        ),
      }));
      const upload = async () => {
        await expect(
          page.getByRole("button", { name: "Stop run" }),
        ).toHaveCount(0);
        await editor.fill("/import");
        await editor.press("Escape");
        const chooser = page.waitForEvent("filechooser");
        await editor.press("Enter");
        await (
          await chooser
        ).setFiles([
          ...histories,
          {
            name: "bad.jsonl",
            mimeType: "application/json",
            buffer: Buffer.from("not-json"),
          },
          {
            name: "mismatch.jsonl",
            mimeType: "application/json",
            buffer: Buffer.from(
              JSON.stringify({
                type: "session",
                version: 3,
                id: randomUUID(),
                cwd: fixture.root,
              }) + "\n",
            ),
          },
        ]);
      };
      await upload();
      const imports = page.getByRole("region", { name: "Import preview" });
      await expect(imports).toContainText("incompatible");
      await expect(imports).toContainText("path-mismatch");
      await expect(imports.getByRole("checkbox").nth(0)).toBeChecked();
      await expect(imports.getByRole("checkbox").nth(1)).toBeChecked();
      await imports.getByRole("button", { name: "Import selected" }).click();
      await expect(imports).toContainText("imported");
      await expect
        .poll(
          () =>
            fixture.host.store
              .list("session")
              .filter((s) => s.nameSource === "imported").length,
        )
        .toBe(2);
      await page.keyboard.press("Escape");
      await upload();
      await expect(imports).toContainText("duplicate");
      await expect(
        imports.getByRole("button", { name: "Import selected" }),
      ).toBeDisabled();
      await page.keyboard.press("Escape");
      await fixture.restart(page);
      // Restart does not silently relaunch an idle Pi child. Resume the
      // isolated fixture explicitly before requesting fresh runtime stats.
      await fixture.execute("session.resume", {}, fixture.session.id);
      await expect
        .poll(
          async () =>
            (await fixture.execute("session.context", {}, fixture.session.id))
              .contextUsage,
        )
        .toEqual({
          tokens: 42000,
          contextWindow: 128000,
          percent: 32.8125,
        });
      expect(
        (await fixture.execute("session.context", {}, fixture.session.id))
          .compactionHistory,
      ).toBeUndefined();
      expect(
        fixture.host.store
          .list("session")
          .filter((s) => s.nameSource === "imported"),
      ).toHaveLength(2);
      await expect(
        page.getByRole("button", { name: "Open hello.txt:2", exact: true }),
      ).toBeVisible();
      await page.screenshot({
        path: testInfo.outputPath("browser-ui.png"),
        fullPage: true,
      });
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
    } finally {
      await fixture.close();
    }
  });

test("real session menu target, active naming, queue stop, clone and fork", async ({
  page,
}) => {
  const fixture = await browserHost();
  try {
    await fixture.login(page);
    const editor = page.getByRole("textbox", { name: "Message Pi" });
    await editor.fill("HOLD synthetic run");
    await editor.press("Enter");
    await expect(page.getByRole("button", { name: "Stop run" })).toBeVisible();
    await page.getByRole("button", { name: "Rename current session" }).click();
    let menu = page.getByRole("menu");
    await menu.getByRole("menuitem", { name: "Rename", exact: true }).click();
    await menu
      .getByRole("textbox", { name: "Session name" })
      .fill("Manual active title");
    await menu.getByRole("textbox", { name: "Session name" }).press("Enter");
    await expect(
      page.getByRole("button", { name: "Rename current session" }),
    ).toContainText("Manual active title");
    await expect(
      page.getByRole("button", { name: "Follow-up", exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Steer", exact: true }),
    ).toHaveCount(0);
    await editor.fill("Queued follow up");
    await editor.press("Enter");
    await expect(editor).toHaveValue("");
    await editor.fill("Queued steer");
    await editor.press("Meta+Enter");
    await expect(editor).toHaveValue("");
    await page.getByRole("button", { name: "Stop run" }).click();
    await expect(page.getByRole("button", { name: "Stop run" })).toHaveCount(0);
    const calls = (
      await readFile(join(fixture.workspace, "rpc-calls.jsonl"), "utf8")
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(calls.map((c) => c.type)).toEqual(
      expect.arrayContaining(["follow_up", "steer", "clear_queue", "abort"]),
    );
    expect(calls.findIndex((c) => c.type === "clear_queue")).toBeLessThan(
      calls.findIndex((c) => c.type === "abort"),
    );
    await editor.fill("/reload");
    await editor.press("Escape");
    await editor.press("Enter");
    await expect(editor).toHaveValue("");
    await fixture.restart(page);
    await expect(
      page.getByRole("button", { name: "Rename current session" }),
    ).toContainText("Manual active title");
    // Right-click a different row while the draft session remains selected.
    await page
      .getByRole("button", { name: "New session ⌃⌥N", exact: true })
      .click();
    await page
      .getByRole("dialog", { name: "New session" })
      .getByRole("button", { name: "Create session" })
      .click();
    await expect(
      page.getByRole("button", { name: "Rename current session" }),
    ).toContainText("New session");
    const selected = await page.evaluate(() =>
      localStorage.getItem("suri.selected"),
    );
    await page
      .getByRole("button", { name: "Manual active title", exact: true })
      .click({ button: "right" });
    menu = page.getByRole("menu");
    await menu.getByRole("menuitem", { name: "Pin", exact: true }).click();
    await expect(
      page.locator(".sidebar-section").filter({
        has: page.getByRole("button", { name: "Pinned", exact: true }),
      }),
    ).toContainText("Manual active title");
    expect(
      await page.evaluate(() => localStorage.getItem("suri.selected")),
    ).toBe(selected);
    await page
      .getByRole("button", { name: "Manual active title", exact: true })
      .click({ button: "right" });
    await page
      .getByRole("menuitem", { name: "Clone session", exact: true })
      .click();
    await expect
      .poll(
        () =>
          fixture.host.store
            .list("session")
            .filter((s) => s.parentId === fixture.session.id).length,
      )
      .toBe(1);
    // Clone transfers the owned Pi process to its child. Explicitly resume the
    // original before requesting observational tree metadata for a fork.
    // The accepted resume is an async job; it is refused while the cloned-away
    // process is still exiting, so retry until the original owns a runtime again.
    await expect
      .poll(async () => {
        await fixture.execute("session.resume", {}, fixture.session.id);
        await new Promise((done) => setTimeout(done, 200));
        return fixture.host.children.has(fixture.session.id);
      })
      .toBe(true);
    await expect
      .poll(
        () =>
          fixture.host.store.snapshot(`session:${fixture.session.id}`).phase,
      )
      .toBe("idle");
    await page
      .getByRole("button", { name: "Manual active title", exact: true })
      .click({ button: "right" });
    await page
      .getByRole("menuitem", { name: "Fork session", exact: true })
      .click();
    await page.getByRole("button", { name: "Branch here" }).click();
    await expect
      .poll(
        () =>
          fixture.host.store
            .list("session")
            .filter((s) => s.parentId === fixture.session.id).length,
      )
      .toBe(2);
    await expect(editor).toHaveValue("Forkable synthetic turn");
    await page
      .getByRole("button", { name: "Manual active title", exact: true })
      .click({ button: "right" });
    await page.getByRole("menuitem", { name: "Archive", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "Manual active title", exact: true }),
    ).toHaveCount(0);
    await page
      .getByRole("button", { name: "Archived sessions", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Manual active title", exact: true })
      .click({ button: "right" });
    await page
      .getByRole("menuitem", { name: "Unarchive", exact: true })
      .click();
    await expect
      .poll(
        () => fixture.host.store.get("session", fixture.session.id).archived,
      )
      .toBe(false);
  } finally {
    await fixture.close();
  }
});

test("bounded file failures preserve context, and real Git changes remain structured", async ({
  page,
}) => {
  const fixture = await browserHost();
  try {
    await writeFile(
      join(fixture.workspace, "binary.bin"),
      Buffer.from([0, 1, 2]),
    );
    await writeFile(join(fixture.workspace, "large.txt"), "x".repeat(1048577));
    await writeFile(join(fixture.workspace, "vanishing.txt"), "temporary");
    await symlink(
      join(fixture.root, "outside"),
      join(fixture.workspace, "escape-link"),
    );
    const { execFileSync } = await import("node:child_process");
    execFileSync("/usr/bin/git", ["init", fixture.workspace], {
      stdio: "ignore",
    });
    execFileSync("/usr/bin/git", ["-C", fixture.workspace, "add", "hello.txt"]);
    await writeFile(
      join(fixture.workspace, "hello.txt"),
      "changed line\nsecond line\n",
    );
    await page.setViewportSize({ width: 760, height: 900 });
    await fixture.login(page);
    const editor = page.getByRole("textbox", { name: "Message Pi" });
    for (const name of ["binary.bin", "large.txt", "vanishing.txt"]) {
      await editor.fill(`@${name}`);
      await expect(
        page.getByRole("option", { name, exact: true }),
      ).toBeVisible();
      if (name === "vanishing.txt") await unlink(join(fixture.workspace, name));
      await editor.press("Enter");
      await expect(page.getByRole("alert")).toBeVisible();
      await expect(editor).toHaveValue(`@${name}`);
      await expect(
        page.getByRole("button", { name: `Remove ${name}` }),
      ).toHaveCount(0);
    }
    await expect(
      fixture.execute("file.read", {
        workspaceId: fixture.workspaceId,
        path: "../outside",
      }),
    ).rejects.toThrow();
    await expect(
      fixture.execute("file.read", {
        workspaceId: fixture.workspaceId,
        path: "escape-link",
      }),
    ).rejects.toThrow();
    await page.getByRole("button", { name: "Open workspace details" }).click();
    await page.getByRole("tab", { name: "Files", exact: true }).click();
    await expect(
      page.getByRole("treeitem", { name: /escape-link/ }),
    ).toBeDisabled();
    await page
      .getByRole("treeitem", { name: "large.txt", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "Save a Copy", exact: true }),
    ).toBeDisabled();
    await page.getByRole("tab", { name: "Changes", exact: true }).click();
    await page.getByRole("option", { name: /hello\.txt Modified/ }).click();
    const helloChanges = page.getByLabel("Changes in hello.txt");
    await expect(helloChanges).toContainText("changed line");
    await expect(helloChanges).toContainText("first line");
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  } finally {
    await fixture.close();
  }
});

test("built-in utility routes and commands on an unopened session use real host receipts", async ({
  page,
  context,
  browserName,
}) => {
  const fixture = await browserHost();
  try {
    const unopened = await fixture.execute("session.create", {
      workspaceId: fixture.workspaceId,
      runtimeId: fixture.runtime.id,
      name: "Unopened session",
    });
    await fixture.execute(
      "session.rename",
      { name: "Unopened session" },
      unopened.id,
      unopened.revision,
    );
    await fixture.login(page);
    // Playwright WebKit does not expose clipboard permissions. Other utility
    // routes still run there; real clipboard round-trip is checked in Chromium.
    if (browserName === "chromium")
      await context.grantPermissions(["clipboard-read", "clipboard-write"], {
        origin: fixture.host.origin,
      });
    const editor = page.getByRole("textbox", { name: "Message Pi" });
    await editor.fill("Synthetic utility setup");
    await editor.press("Enter");
    await expect(
      page.getByRole("button", { name: "Open hello.txt:2", exact: true }),
    ).toBeVisible();
    const slash = async (text: string) => {
      await editor.fill(text);
      await editor.press("Escape");
      await editor.press("Enter");
    };
    for (const [name, title] of [
      ["hotkeys", "Keyboard shortcuts"],
      ["changelog", "Pi runtime"],
      ["session", "Session information"],
      ["settings", "Settings"],
    ]) {
      await slash(`/${name}`);
      const modal = page.getByRole("dialog");
      await expect(modal).toContainText(title);
      await page.keyboard.press("Tab");
      expect(
        await page.evaluate(
          () => !!document.activeElement?.closest('[role="dialog"]'),
        ),
      ).toBe(true);
      await page.keyboard.press("Escape");
      await expect(modal).toHaveCount(0);
    }
    for (const [name, label] of [
      ["model", "Model"],
      ["thinking", "Thinking level"],
    ]) {
      await slash(`/${name}`);
      // The search-first model picker lists models only on request.
      if (name === "model")
        await page.getByRole("button", { name: "Show all models" }).click();
      await expect(
        page.getByRole("listbox", { name: label, exact: true }),
      ).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(
        page.getByRole("button", { name: label, exact: true }),
      ).toBeFocused();
    }
    if (browserName === "chromium") {
      await slash("/copy");
      expect(
        await page.evaluate(() => navigator.clipboard.readText()),
      ).toContain("Synthetic reply");
    }
    const download = page.waitForEvent("download");
    await slash("/export");
    expect((await download).suggestedFilename()).toContain("Browser fixture");
    await slash("/scoped-models");
    await expect(page.getByRole("dialog")).toContainText("model");
    await page.keyboard.press("Escape");
    await slash("/resume");
    await expect(
      page.getByRole("textbox", { name: "Filter projects and sessions" }),
    ).toBeFocused();
    await page
      .getByRole("button", { name: "Unopened session", exact: true })
      .click({ button: "right" });
    await page
      .getByRole("menuitem", { name: "Clone session", exact: true })
      .click();
    await expect(page.getByRole("menu")).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Rename current session" }),
    ).toContainText("Unopened session · branch");
    expect(
      fixture.host.store
        .list("session")
        .some((s) => s.parentId === unopened.id),
    ).toBe(true);
  } finally {
    await fixture.close();
  }
});

test("real transport latency never clears a newer composer edit", async ({
  page,
  context,
  browserName,
}) => {
  test.skip(
    browserName !== "chromium",
    "Transport latency is injected with Chromium CDP, not mocked HTTP responses.",
  );
  const fixture = await browserHost();
  try {
    await fixture.login(page);
    await expect(page.getByRole("status")).toContainText("Connected");
    const cdp = await context.newCDPSession(page);
    await cdp.send("Network.enable");
    await cdp.send("Network.emulateNetworkConditions", {
      offline: false,
      latency: 200,
      downloadThroughput: -1,
      uploadThroughput: -1,
    });
    const editor = page.getByRole("textbox", { name: "Message Pi" });
    await editor.fill("Submitted draft");
    await editor.press("Enter");
    await editor.fill("Next draft typed during receipt");
    await expect(
      page.getByRole("button", { name: "Send message", exact: true }),
    ).toBeEnabled();
    await expect(editor).toHaveValue("Next draft typed during receipt");
    await expect(
      page.getByRole("button", { name: "Open hello.txt:2", exact: true }),
    ).toBeVisible();
    await editor.fill("REJECT_DELAY original");
    await editor.press("Enter");
    await editor.fill("Newer edit");
    await expect(page.getByRole("alert")).toContainText("rejected");
    await expect(editor).toHaveValue("REJECT_DELAY original\n\nNewer edit");
    await page.reload();
    await expect(editor).toHaveValue("REJECT_DELAY original\n\nNewer edit");
  } finally {
    await fixture.close();
  }
});
