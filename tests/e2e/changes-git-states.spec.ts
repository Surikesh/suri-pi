import { test, expect } from "@playwright/test";
import { AxeBuilder } from "@axe-core/playwright";
import { appendFile, writeFile, rename, unlink } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { browserHost } from "../support/browser-host.js";
const exec = promisify(execFile);

test("real Git review preserves new, deleted, renamed, binary and error recovery states", async ({
  page,
}) => {
  const fixture = await browserHost();
  try {
    const git = (...args: string[]) =>
      exec("/usr/bin/git", ["-C", fixture.workspace, ...args]);
    await git("init");
    // Opening the session resumes the fake Pi, which logs RPC calls into the
    // workspace; keep that bookkeeping file out of the changes under test.
    await appendFile(
      join(fixture.workspace, ".git/info/exclude"),
      "rpc-calls.jsonl\n",
    );
    await writeFile(
      join(fixture.workspace, "before.txt"),
      "Rename without changing content\n",
    );
    await writeFile(
      join(fixture.workspace, "binary.dat"),
      Buffer.from([0, 1, 2]),
    );
    await writeFile(
      join(fixture.workspace, "preview.png"),
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
        "base64",
      ),
    );
    await git("add", ".");
    await git(
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "-m",
      "fixture baseline",
    );
    await rename(
      join(fixture.workspace, "before.txt"),
      join(fixture.workspace, "after.txt"),
    );
    await unlink(join(fixture.workspace, "hello.txt"));
    await writeFile(
      join(fixture.workspace, "binary.dat"),
      Buffer.from([0, 3, 4]),
    );
    await writeFile(
      join(fixture.workspace, "preview.png"),
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAQAAABeK7cBAAAADUlEQVR42mP8z8AARAAA//8DAAj8A/2n8Z0AAAAASUVORK5CYII=",
        "base64",
      ),
    );
    await git("add", "-A");
    await writeFile(
      join(fixture.workspace, "new.ts"),
      "export const fresh = true;\n",
    );
    await writeFile(join(fixture.workspace, "empty.txt"), "");
    await page.setViewportSize({ width: 1440, height: 900 });
    await fixture.login(page);
    await expect(
      page.getByRole("textbox", { name: "Message Pi" }),
    ).toBeEnabled();
    await page.getByRole("button", { name: "Open workspace details" }).click();
    const details = page.getByRole("complementary", {
      name: "Workspace details",
    });
    await details.getByRole("tab", { name: "Changes", exact: true }).click();
    const options = details.getByRole("option");
    await expect(options).toHaveCount(6);
    const filter = details.getByRole("searchbox", {
      name: "Filter changed files",
    });
    await filter.fill("preview");
    await expect(options).toHaveCount(1);
    await expect(options.first()).toContainText("preview.png");
    await expect(
      details.getByText("1 of 6 files", { exact: true }),
    ).toBeVisible();
    await filter.fill("missing");
    await expect(details.getByText("No matching files")).toBeVisible();
    await filter.fill("");
    await expect(options).toHaveCount(6);
    await expect(options.filter({ hasText: "after.txt" })).toContainText(
      "before.txt → after.txt",
    );
    await options.filter({ hasText: "binary.dat" }).click();
    const binaryState = details.getByRole("region", {
      name: "Binary file details",
    });
    await expect(binaryState).toContainText("Binary file");
    await expect(binaryState).toContainText("DAT · 3 B");
    await expect(binaryState).toContainText("Open or Open With…");
    await options.filter({ hasText: "preview.png" }).click();
    const image = details.getByRole("img", {
      name: "Preview of preview.png",
    });
    await expect(image).toBeVisible();
    await expect
      .poll(() =>
        image.evaluate((element: HTMLImageElement) => element.naturalWidth),
      )
      .toBe(2);
    await expect(details.getByText(/PNG · \d+ B · 2 × 1/)).toBeVisible();
    await options.filter({ hasText: "hello.txt" }).click();
    const deleted = details.getByLabel("Changes in hello.txt", { exact: true });
    await expect(deleted.locator(".diff-line.remove")).toHaveCount(2);
    await expect(deleted.locator(".diff-line.add")).toHaveCount(0);
    await expect(
      deleted
        .locator(".diff-line.remove")
        .first()
        .locator(".diff-number")
        .first(),
    ).toHaveText("1");
    await options.filter({ hasText: "new.ts" }).click();
    await expect(
      details.getByRole("heading", { name: "New file · working tree" }),
    ).toBeVisible();
    await expect(
      details
        .getByLabel("Changes in new.ts", { exact: true })
        .locator(".diff-line.add"),
    ).toHaveCount(1);
    await options.filter({ hasText: "empty.txt" }).click();
    await expect(
      details.locator(".change-preview-header .diff-additions"),
    ).toHaveText("+0");
    // Keep a delayed status snapshot from repopulating a later refresh.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let held = false;
    await page.route("**/v1/commands", async (route) => {
      const body = route.request().postDataJSON();
      if (body.type === "git.status" && !held) {
        const response = await route.fetch();
        held = true;
        await gate;
        await route.fulfill({ response });
      } else await route.continue();
    });
    await details.getByRole("button", { name: "Refresh changes" }).click();
    await expect.poll(() => held).toBe(true);
    await details.getByRole("tab", { name: "Files", exact: true }).click();
    await writeFile(
      join(fixture.workspace, "later.txt"),
      "Later status result\n",
    );
    await details.getByRole("tab", { name: "Changes", exact: true }).click();
    await expect(options).toHaveCount(7);
    release();
    await page.unrouteAll({ behavior: "wait" });
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
    await expect(options).toHaveCount(7);
    // Explicit failed read, then a real refresh recovers without changing selection.
    await page.route("**/v1/commands", async (route) => {
      const body = route.request().postDataJSON();
      if (body.type === "git.diff" && body.payload.path === "new.ts")
        await route.fulfill({
          json: {
            v: 1,
            id: body.id,
            status: "rejected",
            error: {
              code: "STORAGE_UNAVAILABLE",
              message: "Synthetic read unavailable",
              retryable: true,
            },
          },
        });
      else await route.continue();
    });
    await options.filter({ hasText: "new.ts" }).click();
    await expect(details.getByRole("alert")).toHaveText(
      "Synthetic read unavailable",
    );
    await page.unrouteAll({ behavior: "wait" });
    await details.getByRole("button", { name: "Refresh changes" }).click();
    await expect(
      details.getByLabel("Changes in new.ts", { exact: true }),
    ).toContainText("export const fresh");
    const external: { type: string; path: string }[] = [];
    await page.route("**/v1/commands", async (route) => {
      const body = route.request().postDataJSON();
      if (["file.open", "file.openWith", "file.reveal"].includes(body.type)) {
        external.push({ type: body.type, path: body.payload.path });
        await route.fulfill({
          json: { v: 1, id: body.id, status: "completed", result: {} },
        });
      } else await route.continue();
    });
    for (const name of ["Open", "Open With…", "Reveal"])
      await details.getByRole("button", { name, exact: true }).click();
    await options.filter({ hasText: "new.ts" }).dblclick();
    await expect
      .poll(() => external)
      .toEqual([
        { type: "file.open", path: "new.ts" },
        { type: "file.openWith", path: "new.ts" },
        { type: "file.reveal", path: "new.ts" },
        { type: "file.open", path: "new.ts" },
      ]);
    await page.unrouteAll({ behavior: "wait" });
    for (const width of [1440, 760, 390]) {
      await page.setViewportSize({ width, height: 900 });
      const result = await new AxeBuilder({ page })
        .include(".workspace-details")
        .analyze();
      expect(
        result.violations.filter((v) =>
          ["critical", "serious"].includes(v.impact ?? ""),
        ),
      ).toEqual([]);
    }
  } finally {
    await fixture.close();
  }
});
