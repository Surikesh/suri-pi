import { test, expect } from "@playwright/test";
import { perfBudget } from "./perf-budget.js";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { browserHost } from "../support/browser-host.js";

const candidate = resolve(
  ".build/ui",
  JSON.parse(await readFile(".build/ui/latest.json", "utf8")).buildId,
);

for (const width of [1440, 390])
  test(`cold searchable model picker ${width}`, async ({
    page,
    browserName,
  }) => {
    page.setViewportSize({ width, height: 844 });
    const fixture = await browserHost(candidate);
    try {
      const executable = join(fixture.root, "fake-pi", "dist", "cli.mjs");
      let source = await readFile(executable, "utf8");
      source = source.replace(
        "import { appendFileSync, readFileSync, writeFileSync }",
        "import { appendFileSync, readFileSync, writeFileSync, existsSync }",
      );
      source = source.replace(
        'createInterface({ input: process.stdin }).on("line", (line) => {',
        'createInterface({ input: process.stdin }).on("line", async (line) => {',
      );
      source = source.replace(
        '    case "get_available_models":\n      data = {',
        '    case "get_available_models":\n      await new Promise((done) => { const timer = setInterval(() => { if (existsSync("release-models")) { clearInterval(timer); done(); } }, 10); });\n      data = {',
      );
      source = source.replace(
        "          model,\n          {",
        '          model,\n          ...["moonshotai/kimi-k2.5-fast", "moonshotai/kimi-k2.5-very-long-thinking-variant-with-extra-context"].map((id) => ({ provider: "openrouter", id, name: "MoonshotAI: Kimi K2.5", reasoning: true })),\n          { provider: "openrouter", id: "moonshotai/kimi-k2.5-unabridged", name: "MoonshotAI: Kimi K2.5 Long Context Experimental (Preview)", reasoning: true },\n          ...Array.from({length: 3000}, (_, index) => ({ provider: "synthetic", id: `model-${String(index).padStart(4,"0")}`, name: `Model ${index}`, reasoning: true })),\n          {',
      );
      await writeFile(executable, source);
      expect(fixture.host.children.size).toBe(0);
      await fixture.login(page);
      const rpc = () =>
        readFile(join(fixture.workspace, "rpc-calls.jsonl"), "utf8").catch(
          () => "",
        );
      await expect
        .poll(
          async () => (await rpc()).match(/get_available_models/g)?.length ?? 0,
        )
        .toBe(1);
      const firstFrame = await page.evaluate(
        () =>
          new Promise<{ elapsed: number; focused: boolean }>((done) => {
            const start = performance.now();
            (
              document.querySelector(
                ".model-search-picker > button",
              ) as HTMLButtonElement
            ).click();
            requestAnimationFrame(() =>
              done({
                elapsed: performance.now() - start,
                focused:
                  document.activeElement?.getAttribute("aria-label") ===
                  "Search models",
              }),
            );
          }),
      );
      expect(firstFrame.focused).toBe(true);
      // Chromium is the measured baseline; WebKit still must focus before discovery.
      if (browserName === "chromium")
        expect(firstFrame.elapsed).toBeLessThan(perfBudget(150));
      const search = page.getByRole("combobox", { name: "Search models" });
      await expect(search).toBeFocused();
      await expect(
        page.getByText("Start typing a model or provider name."),
      ).toHaveCount(0);
      await expect(page.getByText(/Current model:/)).toHaveCount(0);
      expect((await rpc()).match(/get_available_models/g)).toHaveLength(1);
      await page.screenshot({
        path: `.build/model-search-compact-${width}.png`,
      });
      await search.fill("model-0001");
      await expect(page.getByText("Loading models…")).toBeVisible();
      await expect(search).toHaveValue("model-0001");
      expect((await rpc()).match(/get_available_models/g)).toHaveLength(1);
      await writeFile(join(fixture.workspace, "release-models"), "ready");
      await expect(
        page.getByRole("option", { name: /model-0001/i }),
      ).toBeVisible();
      await page.screenshot({ path: `.build/model-search-${width}.png` });
      const bounds = await page.locator(".model-search-menu").boundingBox();
      expect(bounds!.x).toBeGreaterThanOrEqual(0);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
      expect(await page.getByRole("option").count()).toBeLessThanOrEqual(20);
      await page.getByRole("option", { name: /model-0001/i }).click();
      await expect(
        page.getByRole("button", { name: "Model", exact: true }),
      ).toContainText("model-0001");
      const calls = (
        await readFile(join(fixture.workspace, "rpc-calls.jsonl"), "utf8")
      )
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(
        calls.some(
          (call) => call.type === "set_model" && call.modelId === "model-0001",
        ),
      ).toBe(true);
      expect(calls.some((call) => call.type === "prompt")).toBe(false);
      expect(
        calls.filter((call) => call.type === "get_available_models"),
      ).toHaveLength(1);
      await page.getByRole("button", { name: "Model", exact: true }).click();
      await expect(
        page.getByText("Start typing a model or provider name."),
      ).toHaveCount(0);
      await search.fill("MoonshotAI");
      const variants = page.getByRole("option", {
        name: /openrouter · MoonshotAI: Kimi K2\.5 \(moonshotai\/kimi/i,
      });
      await expect(variants).toHaveCount(2);
      await expect(variants.nth(0)).toHaveText(
        "openrouter · MoonshotAI: Kimi K2.5 (moonshotai/kimi-k2.5-fast)",
      );
      await expect(variants.nth(1)).toHaveText(
        "openrouter · MoonshotAI: Kimi K2.5 (moonshotai/kimi-k2.5-very-long-thinking-variant-with-extra-context)",
      );
      const unique = page.getByRole("option", {
        name: /moonshotai\/kimi-k2\.5-unabridged/i,
      });
      await expect(unique).toHaveText(
        "openrouter · MoonshotAI: Kimi K2.5 Long Context Experimental (Preview)",
      );
      await expect(page.locator(".model-search-options small")).toHaveCount(0);
      expect(
        await variants
          .nth(1)
          .evaluate((node) => node.scrollWidth <= node.clientWidth + 1),
      ).toBe(true);
      expect(
        await variants
          .nth(1)
          .evaluate(
            (node) => getComputedStyle(node.querySelector("span")!).whiteSpace,
          ),
      ).toBe("normal");
      await page.screenshot({
        path: `.build/model-search-variants-${width}-${browserName}.png`,
      });
      await search.fill("model-2999");
      await expect(
        page.getByRole("option", { name: /model-2999/i }),
      ).toBeVisible();
      await search.fill("");
      await expect(page.getByRole("option")).toHaveCount(0);
      expect(
        (
          await readFile(join(fixture.workspace, "rpc-calls.jsonl"), "utf8")
        ).match(/get_available_models/g),
      ).toHaveLength(1);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      ).toBe(true);
    } finally {
      await writeFile(join(fixture.workspace, "release-models"), "ready");
      await fixture.close();
    }
  });

test("failed discovery retries only on request; scope remains searchable", async ({
  page,
}) => {
  const fixture = await browserHost(candidate);
  try {
    const executable = join(fixture.root, "fake-pi", "dist", "cli.mjs");
    let source = await readFile(executable, "utf8");
    source = source.replace(
      '    case "get_available_models":\n      data = {',
      `    case "get_available_models":
      if (!globalThis.failedOnce) {
        globalThis.failedOnce = true;
        emit({type: "response", id: c.id, command: c.type, success: false, data: {}});
        return;
      }
      data = {`,
    );
    await writeFile(executable, source);
    await fixture.login(page);
    await page.getByRole("button", { name: "Model", exact: true }).click();
    await page
      .getByRole("combobox", { name: "Search models" })
      .fill("alternate");
    await expect(page.getByRole("alert")).toBeVisible();
    const calls = () =>
      readFile(join(fixture.workspace, "rpc-calls.jsonl"), "utf8");
    expect((await calls()).match(/get_available_models/g)).toHaveLength(1);
    await page.getByRole("combobox", { name: "Search models" }).fill("fixture");
    expect((await calls()).match(/get_available_models/g)).toHaveLength(1);
    await page
      .getByRole("combobox", { name: "Search models" })
      .fill("alternate");
    await page.getByRole("combobox", { name: "Search models" }).press("Tab");
    await expect(
      page.getByRole("button", { name: "Retry discovery" }),
    ).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(
      page.getByRole("option", { name: /alternate/i }),
    ).toBeVisible();
    expect((await calls()).match(/get_available_models/g)).toHaveLength(2);
    await page.keyboard.press("Escape");
    await expect(
      page.getByRole("button", { name: "Model", exact: true }),
    ).toBeFocused();
    const editor = page.getByRole("textbox", { name: "Message Pi" });
    await editor.fill("/scoped-models");
    await editor.press("Escape");
    await editor.press("Enter");
    const dialog = page.getByRole("dialog", { name: "Models in picker" });
    await expect(dialog).toBeVisible();
    await dialog
      .getByRole("searchbox", { name: "Search models" })
      .fill("alternate");
    await expect(dialog.locator(".model-scope-list label")).toHaveCount(1);
    await dialog.locator('.model-scope-list input[type="checkbox"]').uncheck();
    await dialog
      .getByRole("searchbox", { name: "Search models" })
      .fill("fixture-model");
    await dialog.locator('.model-scope-list input[type="checkbox"]').uncheck();
    await dialog.getByRole("button", { name: "Save scope" }).click();
    await page.getByRole("button", { name: "Model", exact: true }).click();
    await page
      .getByRole("combobox", { name: "Search models" })
      .fill("alternate");
    await expect(page.getByText("No matching models")).toBeVisible();
    await page
      .getByRole("combobox", { name: "Search models" })
      .fill("fixture-model");
    await expect(
      page.getByRole("option", { name: /fixture-model/i }),
    ).toBeVisible();
  } finally {
    await fixture.close();
  }
});

test("late discovery cannot replace a different session catalog", async ({
  page,
}) => {
  const fixture = await browserHost(candidate);
  try {
    const executable = join(fixture.root, "fake-pi", "dist", "cli.mjs");
    let source = await readFile(executable, "utf8");
    source = source.replace(
      "import { appendFileSync, readFileSync, writeFileSync }",
      "import { appendFileSync, readFileSync, writeFileSync, existsSync }",
    );
    source = source.replace(
      'createInterface({ input: process.stdin }).on("line", (line) => {',
      'createInterface({ input: process.stdin }).on("line", async (line) => {',
    );
    source = source.replace(
      '    case "get_available_models":\n      data = {',
      `    case "get_available_models":
      if (file.includes("${fixture.session.id}")) await new Promise((done) => { const timer = setInterval(() => { if (existsSync("release-a-models")) { clearInterval(timer); done(); } }, 10); });
      data = {`,
    );
    source = source.replace(
      '      break;\n    case "get_available_thinking_levels":',
      `      data.models = [{ provider: "synthetic", id: file.includes("${fixture.session.id}") ? "a-only" : "b-only", name: "Session-specific" }];
      break;
    case "get_available_thinking_levels":`,
    );
    await writeFile(executable, source);
    const other = await fixture.execute("session.create", {
      workspaceId: fixture.workspaceId,
      runtimeId: fixture.runtime.id,
    });
    await fixture.execute(
      "session.rename",
      { name: "Other session" },
      other.id,
      other.revision,
    );
    await fixture.login(page);
    const editor = page.getByRole("textbox", { name: "Message Pi" });
    const calls = async () =>
      (
        await readFile(
          join(fixture.workspace, "rpc-calls.jsonl"),
          "utf8",
        ).catch(() => "")
      ).match(/get_available_models/g)?.length ?? 0;
    await expect.poll(calls).toBe(1);
    await expect(
      page.getByRole("button", { name: "Model", exact: true }),
    ).toBeEnabled();
    await editor.fill("/model");
    await editor.press("Escape");
    await editor.press("Enter");
    await expect(
      page.getByRole("combobox", { name: "Search models" }),
    ).toBeFocused();
    await page.getByRole("combobox", { name: "Search models" }).fill("a-only");
    await expect(page.getByText("Loading models…")).toBeVisible();
    await page
      .getByRole("button", { name: "Other session", exact: true })
      .click();
    await expect(
      page.getByRole("combobox", { name: "Search models" }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Model", exact: true }),
    ).toBeEnabled();
    await page.getByRole("button", { name: "Model", exact: true }).click();
    await page.getByRole("combobox", { name: "Search models" }).fill("b-only");
    await expect(page.getByRole("option", { name: /b-only/i })).toBeVisible();
    await expect.poll(calls).toBe(2);
    await writeFile(join(fixture.workspace, "release-a-models"), "ready");
    await expect(page.getByRole("option", { name: /b-only/i })).toBeVisible();
    await expect(page.getByRole("option", { name: /a-only/i })).toHaveCount(0);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  } finally {
    await writeFile(join(fixture.workspace, "release-a-models"), "ready");
    await fixture.close();
  }
});

test("rejected model selection keeps draft and picker open", async ({
  page,
}) => {
  const fixture = await browserHost(candidate);
  try {
    await fixture.login(page);
    const editor = page.getByRole("textbox", { name: "Message Pi" });
    await editor.fill("unsent draft");
    await page.getByRole("button", { name: "Model", exact: true }).click();
    const search = page.getByRole("combobox", { name: "Search models" });
    await search.fill("rejected");
    await page.getByRole("option", { name: /rejected/i }).click();
    await expect(page.getByRole("alert")).toBeVisible();
    await expect(search).toBeVisible();
    await expect(editor).toHaveValue("unsent draft");
    await expect(
      page.getByRole("button", { name: "Model", exact: true }),
    ).not.toContainText("rejected");
    await expect(
      page.getByRole("button", { name: "Reload models" }),
    ).toBeVisible();
    await search.focus();
    await page.keyboard.press("Tab");
    await expect(
      page.getByRole("button", { name: "Reload models" }),
    ).toBeFocused();
    await page.keyboard.press("Enter");
    await search.fill("alternate");
    await expect(
      page.getByRole("option", { name: /alternate/i }),
    ).toBeVisible();
  } finally {
    await fixture.close();
  }
});

test("Tab leaves the portal and returns to the composer control", async ({
  page,
}) => {
  const fixture = await browserHost(candidate);
  try {
    await fixture.login(page);
    await expect
      .poll(
        async () =>
          (
            await readFile(
              join(fixture.workspace, "rpc-calls.jsonl"),
              "utf8",
            ).catch(() => "")
          ).match(/get_available_models/g)?.length ?? 0,
      )
      .toBe(1);
    await expect(page.locator(".run-status")).toContainText("idle");
    const trigger = page.getByRole("button", { name: "Model", exact: true });
    await trigger.click();
    await expect(
      page.getByRole("combobox", { name: "Search models" }),
    ).toBeFocused();
    await expect(
      page.getByRole("button", { name: "Show all models" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Show all models" }).click();
    await expect(
      page.getByRole("button", { name: "Next results" }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Refresh models" }),
    ).toHaveCount(0);
    await page.getByRole("combobox", { name: "Search models" }).focus();
    await page.keyboard.press("Tab");
    await expect(page.getByRole("option").first()).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(
      page.getByRole("combobox", { name: "Search models" }),
    ).toBeFocused();
    await page.getByRole("option").last().focus();
    await page.keyboard.press("Tab");
    await expect(
      page.getByRole("combobox", { name: "Search models" }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Attach file" }),
    ).toBeFocused();
    await trigger.click();
    await expect(
      page.getByRole("combobox", { name: "Search models" }),
    ).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(
      page.getByRole("textbox", { name: "Message Pi" }),
    ).toBeFocused();
  } finally {
    await fixture.close();
  }
});

for (const width of [1440, 390])
  test(`startup controls stay stable and first Tab opens model search ${width}`, async ({
    page,
    browserName,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 844 });
    const fixture = await browserHost(candidate);
    try {
      const executable = join(fixture.root, "fake-pi", "dist", "cli.mjs");
      let source = await readFile(executable, "utf8");
      source = source.replace(
        "import { appendFileSync, readFileSync, writeFileSync }",
        "import { appendFileSync, readFileSync, writeFileSync, existsSync }",
      );
      source = source.replace(
        'createInterface({ input: process.stdin }).on("line", (line) => {',
        'createInterface({ input: process.stdin }).on("line", async (line) => {',
      );
      source = source.replace(
        '    case "get_state":\n      data = {',
        '    case "get_state":\n      await new Promise((done) => { const timer = setInterval(() => { if (existsSync("release-startup")) { clearInterval(timer); done(); } }, 10); });\n      data = {',
      );
      await writeFile(executable, source);
      // This spec observes the startup window itself, so do not wait it out.
      await fixture.login(page, { settle: false });
      await expect(page.locator(".run-status")).toContainText("starting");
      const editor = page.getByRole("textbox", { name: "Message Pi" });
      const model = page.getByRole("button", { name: "Model", exact: true });
      const send = page.getByRole("button", { name: "Send message" });
      await expect(send).toBeVisible();
      await expect(send).toBeDisabled();
      await expect(page.getByRole("button", { name: "Stop run" })).toHaveCount(
        0,
      );
      await expect(model).toBeEnabled();
      const sendNode = await send.elementHandle();
      const modelNode = await model.elementHandle();
      await editor.focus();
      await page.keyboard.press("Tab");
      await expect(model).toBeFocused();
      await page.keyboard.press("Enter");
      const search = page.getByRole("combobox", { name: "Search models" });
      await expect(search).toBeFocused();
      await expect(
        page.getByText("Start typing a model or provider name."),
      ).toHaveCount(0);
      await expect(page.getByText(/Current model:/)).toHaveCount(0);
      await page.screenshot({
        path: testInfo.outputPath(`startup-model-${width}-${browserName}.png`),
      });
      await search.fill("alternate");
      await expect(page.getByText("Loading models…")).toBeVisible();
      await writeFile(join(fixture.workspace, "release-startup"), "ready");
      await expect(page.locator(".run-status")).toContainText("idle");
      await expect(
        page.getByRole("option", { name: /alternate/i }),
      ).toBeVisible();
      await expect(
        sendNode!.evaluate((node) => node.isConnected),
      ).resolves.toBe(true);
      await expect(
        modelNode!.evaluate((node) => node.isConnected),
      ).resolves.toBe(true);
      await expect(send).toBeVisible();
      await expect(page.getByRole("button", { name: "Stop run" })).toHaveCount(
        0,
      );
      await expect(search).toBeFocused();
      await page.screenshot({
        path: testInfo.outputPath(`ready-model-${width}-${browserName}.png`),
      });
      await page.keyboard.press("Escape");
      await expect(model).toBeFocused();
      await editor.focus();
      await page.keyboard.press("Tab");
      await expect(model).toBeFocused();
      await page.keyboard.press("Tab");
      await expect(
        page.getByRole("button", { name: "Attach file" }),
      ).toBeFocused();
      await editor.fill("HOLD verify Stop remains available during a real run");
      await send.click();
      await expect(
        page.getByRole("button", { name: "Stop run" }),
      ).toBeVisible();
      await page.getByRole("button", { name: "Stop run" }).click();
      await expect(send).toBeVisible();
    } finally {
      await writeFile(join(fixture.workspace, "release-startup"), "ready");
      await fixture.close();
    }
  });

test("ten thousand models remain searchable with one bounded scrolling list", async ({
  page,
}) => {
  const fixture = await browserHost(candidate);
  try {
    const executable = join(fixture.root, "fake-pi", "dist", "cli.mjs");
    let source = await readFile(executable, "utf8");
    source = source.replace(
      "          model,\n          {",
      '          model,\n          ...Array.from({length: 10000}, (_, index) => ({ provider: "synthetic", id: `large-${String(index).padStart(5,"0")}`, name: `Large ${index}`, reasoning: true })),\n          {',
    );
    await writeFile(executable, source);
    await fixture.login(page);
    await page.getByRole("button", { name: "Model", exact: true }).click();
    await page.getByRole("button", { name: "Show all models" }).click();
    await expect(page.getByRole("option")).toHaveCount(40);
    await expect(page.getByText(/\d+ matching models/)).toHaveCount(0);
    const list = page.locator(".model-search-options");
    expect(await page.getByRole("option").count()).toBeLessThanOrEqual(40);
    expect(
      await page
        .locator(".model-search-menu")
        .evaluate((node) => node.scrollHeight <= node.clientHeight),
    ).toBe(true);
    expect(
      await list.evaluate((node) => node.scrollHeight > node.clientHeight),
    ).toBe(true);
    expect(
      await list.evaluate(
        (node) =>
          getComputedStyle(node, "::-webkit-scrollbar-track").backgroundColor,
      ),
    ).toBe("rgba(0, 0, 0, 0)");
    await list.evaluate((node) => {
      node.scrollTop = node.scrollHeight;
    });
    await expect(
      page.getByRole("option", { name: /large-09999/i }),
    ).toBeVisible();
    expect(await page.getByRole("option").count()).toBeLessThanOrEqual(40);
    await page.getByRole("option").last().focus();
    await page.keyboard.press("Tab");
    await expect(
      page.getByRole("button", { name: "Attach file" }),
    ).toBeFocused();
    await page.getByRole("button", { name: "Model", exact: true }).click();
    const queryFrame = await page.evaluate(
      () =>
        new Promise<number>((done) => {
          const input = document.querySelector(
            ".model-search-menu input",
          ) as HTMLInputElement;
          const start = performance.now();
          Object.getOwnPropertyDescriptor(
            HTMLInputElement.prototype,
            "value",
          )!.set!.call(input, "large-09999");
          input.dispatchEvent(new Event("input", { bubbles: true }));
          requestAnimationFrame(() => done(performance.now() - start));
        }),
    );
    expect(queryFrame).toBeLessThan(perfBudget(50));
    await expect(
      page.getByRole("option", { name: /large-09999/i }),
    ).toBeVisible();
    const search = page.getByRole("combobox", { name: "Search models" });
    await search.fill("large-");
    await expect(page.getByRole("option").first()).toHaveAttribute(
      "aria-label",
      /large-00000/i,
    );
    for (let index = 0; index < 45; index++)
      await page.keyboard.press("ArrowDown");
    await expect(search).toHaveAttribute(
      "aria-activedescendant",
      new RegExp(`model-option-.*-45$`),
    );
    await page.keyboard.press("Enter");
    await expect(
      page.getByRole("button", { name: "Model", exact: true }),
    ).toContainText("large-00045");
  } finally {
    await fixture.close();
  }
});

test("prefetched catalog of 425 models stays compact until search or browse", async ({
  page,
}, testInfo) => {
  const fixture = await browserHost(candidate);
  try {
    const executable = join(fixture.root, "fake-pi", "dist", "cli.mjs");
    const source = (await readFile(executable, "utf8")).replace(
      "          model,\n          {",
      '          model,\n          ...Array.from({length: 422}, (_, index) => ({ provider: "synthetic", id: `model-${index}`, name: `Model ${index}` })),\n          {',
    );
    await writeFile(executable, source);
    await fixture.login(page);
    const trigger = page.getByRole("button", { name: "Model", exact: true });
    const calls = async () =>
      (
        await readFile(
          join(fixture.workspace, "rpc-calls.jsonl"),
          "utf8",
        ).catch(() => "")
      ).match(/get_available_models/g) ?? [];
    await expect.poll(async () => (await calls()).length).toBe(1);
    await expect(trigger).toBeEnabled();
    for (let attempt = 0; attempt < 3; attempt++) {
      await trigger.click();
      await expect(
        page.getByRole("combobox", { name: "Search models" }),
      ).toBeFocused();
      await expect(page.getByRole("option")).toHaveCount(0);
      await page.keyboard.press("Escape");
    }
    expect(await calls()).toHaveLength(1);
    await trigger.click();
    await page.getByRole("button", { name: "Show all models" }).click();
    await expect(page.getByRole("option")).toHaveCount(40);
    await expect(page.getByText(/\d+ matching models/)).toHaveCount(0);
    await page.screenshot({
      path: testInfo.outputPath("scroll-list-1440.png"),
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect
      .poll(async () => {
        const box = await page.locator(".model-search-menu").boundingBox();
        return box ? box.x >= 0 && box.x + box.width <= 390 : false;
      })
      .toBe(true);
    await page.screenshot({ path: testInfo.outputPath("scroll-list-390.png") });
    await page.setViewportSize({ width: 1440, height: 900 });
    expect(await page.getByRole("option").count()).toBeLessThanOrEqual(40);
    expect(await calls()).toHaveLength(1);
    await page.locator(".model-search-options").evaluate((node) => {
      node.scrollTop = node.scrollHeight;
    });
    await expect
      .poll(async () =>
        Number(
          (await page.getByRole("option").last().getAttribute("id"))
            ?.split("-")
            .at(-1),
        ),
      )
      .toBeGreaterThan(300);
    expect(await calls()).toHaveLength(1);
    await page.getByRole("combobox", { name: "Search models" }).fill("model");
    await page.getByRole("combobox", { name: "Search models" }).fill("");
    await expect(page.getByRole("option")).toHaveCount(0);
    await page.keyboard.press("Escape");
    await trigger.click();
    const search = page.getByRole("combobox", { name: "Search models" });
    await search.fill("model-421");
    await expect(
      page.getByRole("option", { name: /model-421/i }),
    ).toBeVisible();
    expect(await calls()).toHaveLength(1);
    await search.fill("not-a-model");
    await expect(page.getByText("No matching models")).toBeVisible();
    await expect(page.getByText("No matching models")).toBeVisible();
    expect(await calls()).toHaveLength(1);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => {
      document.documentElement.style.fontSize = "28px";
    });
    await expect
      .poll(
        async () =>
          (await page.locator(".model-search-menu").boundingBox())?.x ?? -1,
      )
      .toBeGreaterThanOrEqual(0);
    await expect
      .poll(async () => {
        const box = await page.locator(".model-search-menu").boundingBox();
        return box ? box.x + box.width : Infinity;
      })
      .toBeLessThanOrEqual(390);
    await expect(search).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Refresh models" }),
    ).toHaveCount(0);
  } finally {
    await fixture.close();
  }
});
