import { test, expect, type Page } from "@playwright/test";
import { AxeBuilder } from "@axe-core/playwright";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { updateFixture } from "../support/update-fixture.js";

test.use({ trace: "off" });
async function ready(page: Page) {
  await expect
    .poll(() =>
      page.evaluate(() => window.suriUpdate?.ready).catch(() => false),
    )
    .toBe(true);
}
test("two clients share activation; explicit follow and broken-entry recovery retain checkpoints", async ({
  browser,
}) => {
  const fixture = await updateFixture();
  const a = await browser.newContext();
  const b = await browser.newContext();
  try {
    await a.addInitScript(() => {
      (window as any).webkit = {
        messageHandlers: { suri: { postMessage() {} } },
      };
    });
    const first = await a.newPage();
    const second = await b.newPage();
    for (const [page, native] of [
      [first, true],
      [second, false],
    ] as const) {
      const bootstrap = await fixture.bootstrap();
      await page.goto(
        bootstrap.origin +
          (native ? "/?shell=2#nonce=" : "/#nonce=") +
          bootstrap.nonce,
      );
      await ready(page);
      await expect(page.getByRole("heading")).toHaveText("Baseline A");
      await expect(page).toHaveURL(
        native
          ? /\/app\?shell=2&window=[a-f0-9-]+$/
          : /\/app\?window=[a-f0-9-]+$/,
      );
    }
    await second.evaluate(() => window.suriUpdate!.pin());
    const before = (await fixture.health()).instanceId;
    const candidate = await fixture.build("Candidate B");
    await fixture.execute("updates.get");
    let injectedTransitionFragment = false;
    await first.route("**/v1/commands", async (route) => {
      if (
        !injectedTransitionFragment &&
        route.request().postDataJSON()?.type === "ui.activate"
      ) {
        injectedTransitionFragment = true;
        const response = await route.fetch();
        const receipt = await response.json();
        receipt.result.url += "#stale-transition-fragment";
        await route.fulfill({ response, json: receipt });
        return;
      }
      await route.continue();
    });
    await first
      .evaluate(
        (buildId) => window.suriUpdate!.transition("ui.prepare", { buildId }),
        candidate.id,
      )
      .catch(() => {});
    await expect(first.getByRole("heading")).toHaveText("Candidate B");
    await ready(first);
    await expect(first).toHaveURL(/\/app\?shell=2&window=[a-f0-9-]+$/);
    await expect(second.getByRole("heading")).toHaveText("Baseline A");
    const status = await first.evaluate(() =>
      window.suriUpdate!.command("updates.get"),
    );
    expect(status.ui.activeId).toBe(candidate.id);
    expect(status.ui.previousKnownGoodId).toBe(fixture.baseline.id);
    expect((await fixture.health()).instanceId).toBe(before);
    await second.reload();
    await ready(second);
    await expect(second.getByRole("heading")).toHaveText("Baseline A");
    await second.evaluate(() => window.suriUpdate!.follow()).catch(() => {});
    await expect(second.getByRole("heading")).toHaveText("Candidate B");
    await ready(second);
    const broken = await fixture.build("Broken", true);
    await fixture.execute("updates.get");
    await first
      .evaluate(
        (buildId) => window.suriUpdate!.transition("ui.prepare", { buildId }),
        broken.id,
      )
      .catch(() => {});
    await expect(first).toHaveURL(/fallback=1/);
    await expect(first).toHaveURL(/shell=2/);
    await ready(first);
    await expect(first.getByRole("heading")).toHaveText("Candidate B");
    const recovered = await first.evaluate(() =>
      window.suriUpdate!.command("updates.get"),
    );
    expect(recovered.ui.activeId).toBe(candidate.id);
    expect(
      recovered.rejected.some(
        (r: { buildId: string }) => r.buildId === broken.id,
      ),
    ).toBe(true);
    expect((await fixture.health()).instanceId).toBe(before);
  } finally {
    await a.close();
    await b.close();
    await fixture.close();
  }
});

test("loader exposes the failing readiness boundary without generic retries", async ({
  page,
}) => {
  const fixture = await updateFixture();
  try {
    await page.route("**/v1/commands", async (route) => {
      if (route.request().postDataJSON()?.type === "ui.ready")
        await route.fulfill({
          json: { status: "rejected", error: { code: "UPDATE_CONFLICT" } },
        });
      else await route.continue();
    });
    const grant = await fixture.bootstrap();
    await page.goto(grant.origin + "/#nonce=" + grant.nonce);
    await expect(
      page.getByText("ready-commit: UPDATE_CONFLICT", { exact: true }),
    ).toBeVisible();
  } finally {
    await fixture.close();
  }
});

test("rich historical session switches retain target content, draft and history", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const latest = JSON.parse(
    await readFile(resolve(".build/ui/latest.json"), "utf8"),
  );
  const fixture = await updateFixture(resolve(".build/ui", latest.buildId));
  try {
    const rich = await fixture.seed();
    const other = {
      ...rich,
      id: crypto.randomUUID(),
      name: "Small synthetic destination",
    };
    fixture.host.store.put("session", other);
    const evictionSessions = Array.from({ length: 4 }, (_, index) => ({
      ...rich,
      id: crypto.randomUUID(),
      name: `Eviction session ${index}`,
    }));
    for (const candidate of evictionSessions) {
      fixture.host.store.put("session", candidate);
      for (let index = 0; index < 101; index++)
        fixture.host.publish(`session:${candidate.id}`, "message.upsert", {
          messageId: `evict-${index}`,
          role: "user",
          revision: 1,
          final: true,
          blocks: [
            {
              id: `evict-body-${index}`,
              kind: "text",
              text: `Eviction ${index}`,
            },
          ],
        });
    }
    for (let index = 0; index < 130; index++) {
      const id = `rich-${index}`;
      fixture.host.publish(`session:${rich.id}`, "message.upsert", {
        messageId: id,
        role: index % 2 ? "user" : "assistant",
        revision: 1,
        final: true,
        blocks: [
          {
            id: `${id}-body`,
            kind: "text",
            text:
              index === 129
                ? "Correct destination marker at the end of the rich session"
                : `Synthetic history ${index}: ${"paragraph with **emphasis** and a list. ".repeat(20)}\n\n\`\`\`typescript\n${"const synthetic = 42;\n".repeat(80)}\`\`\``,
          },
          ...(index === 129
            ? [
                {
                  id: "rich-inline-think",
                  kind: "thinking",
                  text: "Synthetic thinking detail",
                },
              ]
            : []),
          ...(index % 4 === 0 || index === 129
            ? [
                {
                  id: `${id}-tool`,
                  kind: "toolCall",
                  callId: `call-${index}`,
                  name: "read",
                  arguments: { path: "fixture.txt" },
                },
              ]
            : []),
        ],
      });
      if (index % 4 === 0 || index === 129)
        fixture.host.publish(`session:${rich.id}`, "tool.state", {
          callId: `call-${index}`,
          messageId: id,
          name: "read",
          phase: "completed",
          arguments: { path: "fixture.txt" },
          blocks: [
            {
              id: `result-${index}`,
              kind: "text",
              text: "Synthetic tool output",
            },
          ],
        });
    }
    const bootstrap = await fixture.bootstrap();
    await page.goto(bootstrap.origin + "/#nonce=" + bootstrap.nonce);
    await ready(page);
    const editor = page.getByRole("textbox", { name: "Message Pi" });
    await page.getByRole("button", { name: /^Synthetic history 31:/ }).click();
    await expect
      .poll(() =>
        page.evaluate(() =>
          new URLSearchParams(location.search).get("session"),
        ),
      )
      .toBe(rich.id);
    const marker = page
      .locator(".transcript")
      .getByText("Correct destination marker at the end of the rich session");
    await expect(marker).toBeVisible();
    const inline = page.locator(
      '[data-transcript-id="message:rich-129"] details.inline-activity-group',
    );
    await expect(inline.locator("details.tool")).toHaveCount(0);
    await inline.locator(":scope > summary").click();
    await expect(inline.locator("details.tool")).toHaveCount(1);
    const nested = inline.locator("details.tool");
    await nested.locator(":scope > summary").click();
    await expect(nested.locator(".activity-detail")).toBeVisible();
    await editor.fill("Unsent synthetic switching draft");
    const originalExecute = fixture.host.execute.bind(fixture.host);
    fixture.host.execute = async (request, clientId) => {
      if (request.type === "session.history")
        await new Promise((resolve) => setTimeout(resolve, 250));
      return originalExecute(request, clientId);
    };
    await page.getByRole("button", { name: "Earlier messages" }).click();
    await expect(
      page.locator('[data-transcript-id="message:rich-12"]'),
    ).toBeAttached();
    const anchor = page.locator('[data-transcript-id="message:rich-12"]');
    await anchor.evaluate((node) => node.scrollIntoView());
    await expect
      .poll(() =>
        anchor.evaluate((node) => Math.round(node.getBoundingClientRect().top)),
      )
      .toBeGreaterThan(0);
    const anchorY = await anchor.evaluate(
      (node) => node.getBoundingClientRect().top,
    );
    // A late image/disclosure above the reading position must not replace the
    // actual message anchor with a saved numeric scrollTop.
    await page.evaluate(() => {
      (window as any).__switchTasks = [];
      new PerformanceObserver((list) =>
        (window as any).__switchTasks.push(
          ...list.getEntries().map((entry) => entry.duration),
        ),
      ).observe({ type: "longtask", buffered: false });
    });
    for (let index = 0; index < 20; index++) {
      await page.getByRole("button", { name: other.name }).click();
      await expect
        .poll(() =>
          page.evaluate(() =>
            new URLSearchParams(location.search).get("session"),
          ),
        )
        .toBe(other.id);
      await expect(marker).toHaveCount(0);
      const paintStart = Date.now();
      await page
        .getByRole("button", { name: /^Synthetic history 31:/ })
        .click();
      await expect(marker).toBeVisible();
      if (index > 0) expect(Date.now() - paintStart).toBeLessThan(1500);
      await expect(editor).toHaveValue("Unsent synthetic switching draft");
      await expect(inline).toHaveAttribute("open", "");
      await expect(nested).toHaveAttribute("open", "");
      await expect(anchor).toBeAttached();
      await expect
        .poll(() =>
          anchor.evaluate(
            (node, y) => Math.abs(node.getBoundingClientRect().top - y),
            anchorY,
          ),
        )
        .toBeLessThan(8);
      if (index === 0) {
        await page.waitForTimeout(250); // layout arriving after the first restored frame
        await page.locator(".transcript .rail").evaluate((rail) => {
          const spacer = document.createElement("div");
          spacer.style.height = "180px";
          spacer.dataset.delayedLayout = "true";
          rail.prepend(spacer);
        });
        await expect
          .poll(() =>
            anchor.evaluate(
              (node, y) => Math.abs(node.getBoundingClientRect().top - y),
              anchorY,
            ),
          )
          .toBeLessThan(8);
        await page
          .locator("[data-delayed-layout]")
          .evaluate((node) => node.remove());
      }
    }
    // Evict rich's cached history with four distinct history-bearing sessions.
    await page.getByRole("button", { name: other.name }).click();
    for (const candidate of evictionSessions) {
      if (candidate === evictionSessions[3])
        await page.getByRole("button", { name: "Show more" }).click();
      await page.getByRole("button", { name: candidate.name }).click();
      await page.getByRole("button", { name: "Earlier messages" }).click();
      await expect(
        page.locator('[data-transcript-id="message:evict-0"]'),
      ).toBeAttached();
    }
    await page.getByRole("button", { name: /^Synthetic history 31:/ }).click();
    await expect(anchor).toHaveCount(0);
    // A scroll event delivered after the restoration frame is not user intent.
    await page.waitForTimeout(100);
    await page.locator(".transcript").evaluate((node) => {
      node.dispatchEvent(new Event("scroll"));
      node.dispatchEvent(new Event("scroll"));
    });
    await page.getByRole("button", { name: "Earlier messages" }).click();
    await expect(anchor).toBeAttached();
    await expect
      .poll(() =>
        anchor.evaluate(
          (node, y) => Math.abs(node.getBoundingClientRect().top - y),
          anchorY,
        ),
      )
      .toBeLessThan(8);
    await page.locator(".transcript .rail").evaluate((rail) => {
      const spacer = document.createElement("div");
      spacer.style.height = "180px";
      spacer.dataset.delayedLayout = "true";
      rail.prepend(spacer);
    });
    await expect
      .poll(() =>
        anchor.evaluate(
          (node, y) => Math.abs(node.getBoundingClientRect().top - y),
          anchorY,
        ),
      )
      .toBeLessThan(8);
    await page
      .locator("[data-delayed-layout]")
      .evaluate((node) => node.remove());
    // A deliberate jump cancels the still-active anchor restoration, even if
    // queued scroll events and a later layout mutation arrive in either order.
    await page.getByRole("button", { name: "Jump to latest" }).click();
    await page.locator(".transcript").evaluate((node) => {
      node.dispatchEvent(new Event("scroll"));
      node.querySelector(".rail")!.append(
        Object.assign(document.createElement("div"), {
          style: "height: 120px",
        }),
      );
      node.dispatchEvent(new Event("scroll"));
    });
    await expect
      .poll(() =>
        page
          .locator(".transcript")
          .evaluate(
            (node) => node.scrollHeight - node.scrollTop - node.clientHeight,
          ),
      )
      .toBeLessThan(64);
    expect(
      await page.evaluate(
        (id) => localStorage.getItem(`suri.scroll.${id}`),
        rich.id,
      ),
    ).toBeNull();
    await expect
      .poll(() =>
        page.locator('.message pre code span[style*="color"]').count(),
      )
      .toBeGreaterThan(0);
    const longestTask = await page.evaluate(() =>
      Math.max(0, ...(window as any).__switchTasks),
    );
    expect(longestTask).toBeLessThan(300);
    await inline.locator(":scope > summary").focus();
    await page.keyboard.press("Space");
    await expect(inline).not.toHaveAttribute("open", "");
    await expect(inline.locator("details.tool")).toHaveCount(0);
    const typingStart = Date.now();
    await editor.pressSequentially(" Keep typing without submitting.", {
      delay: 2,
    });
    expect(Date.now() - typingStart).toBeLessThan(1500);
    await expect(editor).toHaveValue(
      "Unsent synthetic switching draft Keep typing without submitting.",
    );
    await page.setViewportSize({ width: 760, height: 900 });
    await expect(editor).toBeEnabled();
    await expect(marker).toBeVisible();
    await page.getByRole("button", { name: "Open navigation" }).click();
    await page.getByRole("button", { name: other.name }).click();
    await expect
      .poll(() =>
        page.evaluate(() =>
          new URLSearchParams(location.search).get("session"),
        ),
      )
      .toBe(other.id);
    await expect(marker).toHaveCount(0);
    await page.getByRole("button", { name: "Open navigation" }).click();
    await page.getByRole("button", { name: /^Synthetic history 31:/ }).click();
    await expect(marker).toBeVisible();
    await expect(editor).toHaveValue(
      "Unsent synthetic switching draft Keep typing without submitting.",
    );
    await expect(anchor).toBeAttached();
  } finally {
    await fixture.close();
  }
});

test("Jump to latest wins over a held history response and its queued frame", async ({
  page,
}) => {
  const latest = JSON.parse(
    await readFile(resolve(".build/ui/latest.json"), "utf8"),
  );
  const fixture = await updateFixture(resolve(".build/ui", latest.buildId));
  let release: (() => void) | undefined;
  try {
    const session = await fixture.seed();
    for (let index = 0; index < 230; index++)
      fixture.host.publish(`session:${session.id}`, "message.upsert", {
        messageId: `race-${index}`,
        role: "user",
        revision: 1,
        final: true,
        blocks: [
          {
            id: `body-${index}`,
            kind: "text",
            text: `Race message ${index} ${"long history text ".repeat(30)}`,
          },
        ],
      });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let received!: () => void;
    const requested = new Promise<void>((resolve) => {
      received = resolve;
    });
    const bootstrap = await fixture.bootstrap();
    await page.addInitScript(
      (id) => localStorage.setItem("suri.selected", id),
      session.id,
    );
    await page.goto(bootstrap.origin + "/#nonce=" + bootstrap.nonce);
    await ready(page);
    await expect(
      page.locator('[data-transcript-id="message:race-229"]'),
    ).toBeAttached();
    await page.route("**/v1/commands", async (route) => {
      if (route.request().postDataJSON()?.type === "session.history") {
        received();
        await held;
      }
      await route.continue();
    });
    const transcript = page.locator(".transcript");
    await expect(
      page.getByRole("button", { name: "Earlier messages" }),
    ).toBeVisible();
    await transcript.evaluate((node) => {
      node.scrollTop = 0;
    });
    await expect(
      page.getByRole("button", { name: "Jump to latest" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Earlier messages" }).click();
    await Promise.race([
      requested,
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error("history request never reached host")),
          4000,
        ),
      ),
    ]);
    await page.getByRole("button", { name: "Jump to latest" }).click();
    release!();
    await expect(
      page.getByRole("button", { name: "Earlier messages" }),
    ).toBeEnabled();
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    await transcript.evaluate((node) => {
      node.dispatchEvent(new Event("scroll"));
      node.dispatchEvent(new Event("scroll"));
    });
    await expect
      .poll(() =>
        transcript.evaluate(
          (node) => node.scrollHeight - node.scrollTop - node.clientHeight,
        ),
      )
      .toBeLessThan(64);
    await expect(
      page.getByRole("button", { name: "Jump to latest" }),
    ).toBeHidden();
  } finally {
    release?.();
    await fixture.close();
  }
});

test("Jump to latest wins after the history response queues its restoration frame", async ({
  page,
}) => {
  const latest = JSON.parse(
    await readFile(resolve(".build/ui/latest.json"), "utf8"),
  );
  const fixture = await updateFixture(resolve(".build/ui", latest.buildId));
  try {
    const session = await fixture.seed();
    for (let index = 0; index < 230; index++)
      fixture.host.publish(`session:${session.id}`, "message.upsert", {
        messageId: `race-${index}`,
        role: "user",
        revision: 1,
        final: true,
        blocks: [
          {
            id: `body-${index}`,
            kind: "text",
            text: `Race message ${index} ${"long history text ".repeat(30)}`,
          },
        ],
      });
    const bootstrap = await fixture.bootstrap();
    await page.addInitScript(
      (id) => localStorage.setItem("suri.selected", id),
      session.id,
    );
    await page.goto(bootstrap.origin + "/#nonce=" + bootstrap.nonce);
    await ready(page);
    await expect(
      page.locator('[data-transcript-id="message:race-229"]'),
    ).toBeAttached();
    // Hold only the anchor-restoration callback, not the browser's rendering
    // frames. This hook is installed after startup and before requesting history.
    await page.evaluate(() => {
      const original = window.requestAnimationFrame.bind(window);
      const gate = window as typeof window & {
        __heldHistoryFrame?: FrameRequestCallback;
        __releaseHistoryFrame?: () => void;
      };
      window.requestAnimationFrame = (callback) => {
        const source = callback.toString();
        if (source.includes("CSS.escape") && source.includes("scrollTop")) {
          gate.__heldHistoryFrame = callback;
          return original(() => {});
        }
        return original(callback);
      };
      gate.__releaseHistoryFrame = () => {
        const callback = gate.__heldHistoryFrame;
        if (!callback)
          throw new Error("history restoration frame was not queued");
        gate.__heldHistoryFrame = undefined;
        original(callback);
      };
    });
    const transcript = page.locator(".transcript");
    await expect(
      page.getByRole("button", { name: "Earlier messages" }),
    ).toBeVisible();
    await transcript.evaluate((node) => {
      node.scrollTop = 0;
    });
    await expect(
      page.getByRole("button", { name: "Jump to latest" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Earlier messages" }).click();
    await expect
      .poll(() =>
        page.evaluate(() => Boolean((window as any).__heldHistoryFrame)),
      )
      .toBe(true);
    // DOM click avoids Playwright's actionability wait crossing the held frame.
    await page
      .getByRole("button", { name: "Jump to latest" })
      .evaluate((button: HTMLElement) => button.click());
    await page.evaluate(() => (window as any).__releaseHistoryFrame());
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    await transcript.evaluate((node) => {
      node.dispatchEvent(new Event("scroll"));
      node.dispatchEvent(new Event("scroll"));
    });
    await expect
      .poll(() =>
        transcript.evaluate(
          (node) => node.scrollHeight - node.scrollTop - node.clientHeight,
        ),
      )
      .toBeLessThan(64);
    await expect(
      page.getByRole("button", { name: "Jump to latest" }),
    ).toBeHidden();
  } finally {
    await fixture.close();
  }
});

test("built interface preserves draft and uploaded attachment across update while fake Pi remains busy", async ({
  page,
}) => {
  test.setTimeout(60000);
  const latest = JSON.parse(
    await readFile(resolve(".build/ui/latest.json"), "utf8"),
  );
  const fixture = await updateFixture(resolve(".build/ui", latest.buildId));
  try {
    const session = await fixture.seed();
    const bootstrap = await fixture.bootstrap();
    await page.addInitScript((id) => {
      if (!localStorage.getItem("suri.selected"))
        localStorage.setItem("suri.selected", id);
    }, session.id);
    await page.goto(bootstrap.origin + "/#nonce=" + bootstrap.nonce);
    await ready(page);
    const editor = page.getByRole("textbox", { name: "Message Pi" });
    await expect(editor).toBeEnabled();
    await editor.fill("HOLD update fixture");
    await page
      .getByRole("button", { name: "Send message", exact: true })
      .click();
    await expect.poll(() => fixture.host.children.size).toBe(1);
    await expect
      .poll(async () => (await fixture.health()).activeWork)
      .toBeGreaterThan(0);
    const pid = [...fixture.host.children.values()][0].child.pid;
    const instance = (await fixture.health()).instanceId;
    await editor.fill("Unsent preserved draft");
    await page.locator('input[type="file"][accept*="text/"]').setInputFiles({
      name: "draft-note.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("private fixture attachment"),
    });
    await expect(
      page.getByText("draft-note.txt", { exact: true }),
    ).toBeVisible();
    for (let index = 0; index < 140; index++) {
      const messageId = `history-${index}`;
      fixture.host.publish(`session:${session.id}`, "message.upsert", {
        messageId,
        role: index % 2 ? "user" : "assistant",
        revision: 1,
        final: true,
        blocks: [
          {
            id: `${messageId}-text`,
            kind: "text",
            text: `History message ${index}`,
          },
          ...(index === 12
            ? [
                {
                  id: `${messageId}-tool`,
                  kind: "toolCall",
                  callId: "history-probe",
                  name: "read",
                  arguments: { path: "fixture.txt" },
                },
              ]
            : []),
        ],
      });
    }
    fixture.host.publish(`session:${session.id}`, "tool.state", {
      callId: "history-probe",
      messageId: "history-12",
      name: "read",
      phase: "completed",
      arguments: { path: "fixture.txt" },
      blocks: [
        { id: "history-result", kind: "text", text: "Retained tool output" },
      ],
    });
    await page
      .getByRole("button", { name: "Earlier messages", exact: true })
      .click();
    const historicalAnchor = page.locator(
      '[data-transcript-id="message:history-12"]',
    );
    await expect(historicalAnchor).toBeAttached();
    await historicalAnchor.evaluate((node) =>
      node.scrollIntoView({ block: "start" }),
    );
    const disclosure = historicalAnchor
      .locator("details[data-disclosure-id]")
      .first();
    await disclosure.locator("summary").first().click();
    const beforeAnchor = await page.evaluate(
      () => window.suriCheckpoint!().anchor,
    );
    expect(beforeAnchor.bottomFollow).toBe(false);
    const expanded = await page.evaluate(
      () => window.suriCheckpoint!().expandedIds,
    );
    expect(expanded.length).toBeGreaterThan(0);
    const candidate = await fixture.build("Production B");
    await fixture.execute("updates.get");
    await page
      .getByRole("button", { name: "Interface update ready", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Use new interface", exact: true })
      .click();
    await expect
      .poll(() =>
        page
          .evaluate(() => window.suriUpdate?.descriptor.buildId)
          .catch(() => null),
      )
      .toBe(candidate.id);
    await ready(page);
    await expect(editor).toHaveValue("Unsent preserved draft");
    await expect(
      page.getByText("draft-note.txt", { exact: true }),
    ).toBeVisible();
    expect((await fixture.health()).instanceId).toBe(instance);
    expect([...fixture.host.children.values()][0].child.pid).toBe(pid);
    const restoredAnchor = await page.evaluate(
      () => window.suriCheckpoint!().anchor,
    );
    expect(restoredAnchor.messageId).toBe(beforeAnchor.messageId);
    expect(Math.abs(restoredAnchor.offset - beforeAnchor.offset)).toBeLessThan(
      3,
    );
    expect(
      await page.evaluate(() => window.suriCheckpoint!().expandedIds),
    ).toEqual(expect.arrayContaining(expanded));
    await expect
      .poll(async () => (await fixture.health()).activeWork)
      .toBeGreaterThan(0);
    const keyboardCandidate = await fixture.build("Production C");
    await fixture.execute("updates.get");
    await editor.dispatchEvent("compositionstart", { data: "composing" });
    await page.keyboard.press("ControlOrMeta+Shift+R");
    await expect(
      page.getByRole("button", { name: "Update needs attention", exact: true }),
    ).toBeVisible();
    expect(
      await page.evaluate(() => window.suriUpdate!.descriptor.buildId),
    ).toBe(candidate.id);
    await expect(editor).toHaveValue("Unsent preserved draft");
    await editor.dispatchEvent("compositionend", { data: "" });
    await page.keyboard.press("ControlOrMeta+Shift+R");
    await expect
      .poll(() =>
        page
          .evaluate(() => window.suriUpdate?.descriptor.buildId)
          .catch(() => null),
      )
      .toBe(keyboardCandidate.id);
    await ready(page);
    await expect(editor).toHaveValue("Unsent preserved draft");
    await expect(
      page.getByText("draft-note.txt", { exact: true }),
    ).toBeVisible();
    expect([...fixture.host.children.values()][0].child.pid).toBe(pid);
    const previousClient = await page.evaluate(() => window.suriUpdate!.client);
    expect((await fixture.rendezvous(previousClient)).checkpointed).toBe(true);
    const fresh = await fixture.bootstrap();
    await page.request.post(fresh.origin + "/v1/bootstrap", {
      headers: { Origin: fresh.origin },
      data: { nonce: fresh.nonce },
    });
    await page.goto(fresh.origin + "/app");
    await ready(page);
    expect(await page.evaluate(() => window.suriUpdate!.client)).not.toBe(
      previousClient,
    );
    await expect(editor).toHaveValue("Unsent preserved draft");
    await expect(
      page.getByText("draft-note.txt", { exact: true }),
    ).toBeVisible();
    expect([...fixture.host.children.values()][0].child.pid).toBe(pid);
    await page
      .getByRole("button", { name: "Update status", exact: true })
      .click();
    for (const [width, height] of [
      [1440, 900],
      [760, 900],
      [390, 844],
    ]) {
      await page.setViewportSize({ width, height });
      await expect
        .poll(() =>
          page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
        )
        .toBe(true);
      await page.screenshot({
        path: resolve(`.suri-local/diagnostics/modern-updates-${width}.png`),
      });
    }
    expect(
      (await new AxeBuilder({ page }).include(".updates-control").analyze())
        .violations,
    ).toEqual([]);
    // 200%-equivalent layout viewport at 1440x900 physical pixels; not an OS zoom claim.
    const zoomContext = await page
      .context()
      .browser()!
      .newContext({
        viewport: { width: 720, height: 450 },
        deviceScaleFactor: 2,
      });
    try {
      const zoomPage = await zoomContext.newPage();
      await zoomPage.addInitScript(
        (id) => localStorage.setItem("suri.selected", id),
        session.id,
      );
      const grant = await fixture.bootstrap();
      await zoomPage.goto(grant.origin + "/#nonce=" + grant.nonce);
      await ready(zoomPage);
      await expect(
        zoomPage.getByRole("textbox", { name: "Message Pi" }),
      ).toHaveValue("");
      await zoomPage
        .getByRole("button", { name: "Update status", exact: true })
        .click();
      await zoomPage
        .getByRole("button", { name: "Close updates", exact: true })
        .scrollIntoViewIfNeeded();
      expect(
        await zoomPage.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      const panel = await zoomPage
        .getByRole("region", { name: "Updates", exact: true })
        .boundingBox();
      expect(panel!.y + panel!.height).toBeLessThanOrEqual(450);
      expect(
        (await zoomPage
          .getByRole("textbox", { name: "Message Pi" })
          .boundingBox())!.y,
      ).toBeLessThan(450);
      await zoomPage.screenshot({
        path: resolve(".suri-local/diagnostics/modern-updates-200pct.png"),
      });
    } finally {
      await zoomContext.close();
    }
    const beforeFailure = await page.evaluate(() => window.suriCheckpoint!());
    const missingChunk = await fixture.build("Missing rich chunk D");
    await fixture.execute("updates.get");
    await page.route(`**/ui/${missingChunk.id}/assets/rich-*.js`, (route) =>
      route.abort("failed"),
    );
    await page
      .evaluate(
        (buildId) => window.suriUpdate!.transition("ui.prepare", { buildId }),
        missingChunk.id,
      )
      .catch(() => {});
    await expect(page).toHaveURL(/fallback=1/, { timeout: 15000 });
    await expect
      .poll(() =>
        page
          .evaluate(() => window.suriUpdate?.descriptor.buildId)
          .catch(() => null),
      )
      .toBe(keyboardCandidate.id);
    await ready(page);
    await expect(editor).toHaveValue("Unsent preserved draft");
    await expect(
      page.getByText("draft-note.txt", { exact: true }),
    ).toBeVisible();
    expect([...fixture.host.children.values()][0].child.pid).toBe(pid);
    const recovered = await page.evaluate(() =>
      window.suriUpdate!.command("updates.get"),
    );
    expect(recovered.available.ui.state).toBe("rejected");
    expect(recovered.ui.activeId).toBe(keyboardCandidate.id);
    const afterFailure = await page.evaluate(() => window.suriCheckpoint!());
    expect(afterFailure.anchor.messageId).toBe(beforeFailure.anchor.messageId);
    expect(
      Math.abs(afterFailure.anchor.offset - beforeFailure.anchor.offset),
    ).toBeLessThan(3);
    expect(afterFailure.expandedIds).toEqual(
      expect.arrayContaining(beforeFailure.expandedIds),
    );
    await page.screenshot({
      path: resolve(".suri-local/diagnostics/modern-updates-recovered.png"),
    });
    await page.getByRole("button", { name: "Stop run", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "Stop run", exact: true }),
    ).toHaveCount(0);
    await fixture.host.close();
    await expect(
      page.getByRole("heading", { name: "Suri Pi recovery" }),
    ).toBeVisible({ timeout: 10000 });
    await page.screenshot({
      path: resolve(".suri-local/diagnostics/modern-updates-offline.png"),
    });
    const downloadEvent = page.waitForEvent("download");
    await page
      .getByRole("button", { name: "Download saved window state", exact: true })
      .click();
    const download = await downloadEvent;
    const exported = await readFile((await download.path())!, "utf8");
    expect(exported).toContain("Unsent preserved draft");
    expect(exported).not.toMatch(/nonce|csrf|handoff|verifier/);
  } finally {
    await fixture.close();
  }
});

test("an intentional empty draft and a missing selected session remain recoverable", async ({
  page,
}) => {
  const latest = JSON.parse(
    await readFile(resolve(".build/ui/latest.json"), "utf8"),
  );
  const fixture = await updateFixture(resolve(".build/ui", latest.buildId));
  try {
    const session = await fixture.seed();
    const bootstrap = await fixture.bootstrap();
    await page.addInitScript((id) => {
      if (!localStorage.getItem("suri.selected"))
        localStorage.setItem("suri.selected", id);
    }, session.id);
    await page.goto(bootstrap.origin + "/#nonce=" + bootstrap.nonce);
    await ready(page);
    const editor = page.locator('textarea[aria-label="Message Pi"]');
    await editor.fill("Old server draft");
    await page.evaluate(() => window.suriFlush!());
    await editor.fill("");
    await page.reload();
    await ready(page);
    await expect(editor).toHaveValue("");
    await editor.fill("Orphaned retained draft");
    await page.evaluate(() => window.suriFlush!());
    const missingId = crypto.randomUUID();
    await page.addInitScript((id) => {
      const checkpoint = JSON.parse(sessionStorage.getItem("suri.checkpoint")!);
      checkpoint.selectedSessionId = id;
      sessionStorage.setItem("suri.checkpoint", JSON.stringify(checkpoint));
      const prefix =
        "suri.window." + sessionStorage.getItem("suri.window") + ".";
      localStorage.setItem(prefix + "suri.selected", id);
      localStorage.setItem(prefix + "suri.draft." + id, checkpoint.draft.text);
    }, missingId);
    await page.reload();
    await ready(page);
    await expect(
      page.getByText(/The selected session is no longer available/),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Update status", exact: true })
      .click();
    const event = page.waitForEvent("download");
    await page
      .getByRole("button", { name: "Download saved window state", exact: true })
      .click();
    const download = await event;
    const body = await readFile((await download.path())!, "utf8");
    expect(body).toContain("Orphaned retained draft");
    expect(body).toContain(missingId);
    const status = await page.evaluate(() =>
      window.suriUpdate!.command("updates.get"),
    );
    expect(status.ui.activeId).toBe(fixture.baseline.id);
    expect(status.available.ui.state).toBe("verified");
  } finally {
    await fixture.close();
  }
});
