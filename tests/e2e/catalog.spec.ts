import { test, expect, type Page } from "@playwright/test";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { startHost } from "../../apps/host/src/host.js";
import { control } from "../../apps/host/src/cli.js";
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
  "base64",
);
async function login(page: Page, root: string, origin: string) {
  const b = await control(root, { type: "bootstrap" });
  await page.goto(origin);
  await page.evaluate(async (nonce) => {
    await fetch("/v1/bootstrap", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nonce }),
    });
  }, b.nonce);
  await page.reload();
  await expect(page.getByRole("status")).toContainText("Connected");
}
async function chooseFolder(page: Page, path: string) {
  const dialog = page.getByRole("dialog");
  await expect(
    dialog.getByRole("button", { name: "Go", exact: true }),
  ).toBeEnabled();
  await dialog.getByRole("textbox", { name: "Folder path" }).fill(path);
  await dialog.getByRole("textbox", { name: "Folder path" }).press("Enter");
  await expect(
    dialog.getByRole("button", { name: "Open folder", exact: true }),
  ).toBeEnabled();
  await dialog
    .getByRole("button", { name: "Open folder", exact: true })
    .click();
}
async function sections(page: Page) {
  await page.getByRole("button", { name: "View options", exact: true }).click();
  await page.getByRole("menuitem", { name: "Sidebar sections…" }).click();
}
for (const width of [1440, 390])
  test(`real catalog folder picker icons sections and restart at ${width}`, async ({
    page,
  }, testInfo) => {
    test.setTimeout(60000);
    const root = await mkdtemp(join(tmpdir(), "suri-catalog-"));
    const project = join(root, "Example"),
      worktree = join(root, "Worktree");
    await mkdir(join(project, ".dsh"), { recursive: true });
    await mkdir(worktree);
    const svg = (fill: string) =>
      `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><circle cx="10" cy="10" r="8" fill="${fill}"/></svg>`;
    await writeFile(join(project, ".dsh/icon.svg"), svg("#6D5CE7"));
    await writeFile(join(project, "keep.jsonl"), "synthetic history retained");
    let host = await startHost({
      root: join(root, "data"),
      directoryHome: root,
      assets: resolve("dist/ui"),
      helper: resolve("dist/native/suri-helper"),
    });
    const navigation = async () => {
      if (
        width < 900 &&
        !(await page.locator(".sidebar").getAttribute("class"))?.includes(
          "open",
        )
      )
        await page.getByRole("button", { name: "Open navigation" }).click();
    };
    const manage = async () => {
      await navigation();
      await page
        .getByRole("button", {
          name: "Actions for project Example",
          exact: true,
        })
        .click();
      await page
        .getByRole("menuitem", { name: "Rename project / workspaces…" })
        .click();
    };
    try {
      await page.setViewportSize({ width, height: 900 });
      await login(page, join(root, "data"), host.origin);
      await navigation();
      await page
        .getByRole("button", { name: "Add project", exact: true })
        .click();
      const dialog = page.getByRole("dialog");
      await expect(
        dialog.getByRole("button", { name: "Go", exact: true }),
      ).toBeEnabled();
      await dialog
        .getByRole("textbox", { name: "Folder path" })
        .fill(join(root, "missing"));
      await dialog.getByRole("button", { name: "Go", exact: true }).click();
      await expect(dialog.getByRole("alert")).toBeVisible();
      await expect(
        dialog.getByRole("textbox", { name: "Folder path" }),
      ).toHaveValue(join(root, "missing"));
      await chooseFolder(page, project);
      await expect(dialog).toHaveCount(0);
      await sections(page);
      await dialog
        .getByRole("textbox", { name: "New section name" })
        .fill("Focus");
      await dialog.getByRole("button", { name: "Create section" }).click();
      await expect(
        dialog.getByRole("textbox", {
          name: "Section name Focus",
          exact: true,
        }),
      ).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(dialog).toHaveCount(0);
      const icon = page.getByRole("button", { name: "Set icon for Example" });
      await expect(icon.locator("img")).toBeVisible();
      const auto = await icon.locator("img").getAttribute("src");
      const autoAsset = host.store.get(
        "asset",
        host.store.list("project")[0].autoIconId,
      );
      expect(autoAsset).toMatchObject({ width: 60, height: 60 });
      await expect(icon.locator("img")).toHaveCSS("width", "20px");
      await expect(icon.locator("img")).toHaveCSS("height", "20px");
      await page
        .locator(".sidebar")
        .screenshot({ path: testInfo.outputPath("dsh-icon.png") });
      const chooser = page.waitForEvent("filechooser");
      await icon.click();
      await (
        await chooser
      ).setFiles({ name: "manual.png", mimeType: "image/png", buffer: png });
      await expect(icon.locator("img")).not.toHaveAttribute("src", auto!);
      const manual = await icon.locator("img").getAttribute("src");
      await manage();
      await dialog
        .getByRole("button", { name: "Add workspace…", exact: true })
        .click();
      await chooseFolder(page, worktree);
      await expect(
        dialog.getByRole("button", { name: "Remove workspace Worktree" }),
      ).toBeVisible();
      await dialog
        .getByRole("combobox", { name: "Project section" })
        .selectOption({ label: "Focus" });
      await expect(
        dialog.getByRole("combobox", { name: "Project section" }),
      ).not.toHaveValue("");
      await dialog
        .getByRole("textbox", { name: "Project name", exact: true })
        .fill("Renamed project");
      await dialog.getByRole("button", { name: "Save project name" }).click();
      await expect
        .poll(() => host.store.list("project")[0].label)
        .toBe("Renamed project");
      await page.keyboard.press("Escape");
      await page.getByRole("button", { name: "Focus", exact: true }).click();
      await expect(
        page.getByRole("button", { name: "Set icon for Renamed project" }),
      ).not.toBeVisible();
      await page.reload();
      await navigation();
      await expect(
        page.getByRole("button", { name: "Focus", exact: true }),
      ).toBeVisible();
      await writeFile(join(project, ".dsh/icon.svg"), svg("#E0529C"));
      const port = Number(new URL(host.origin).port);
      await host.close();
      host = await startHost({
        root: join(root, "data"),
        directoryHome: root,
        assets: resolve("dist/ui"),
        helper: resolve("dist/native/suri-helper"),
        port,
      });
      await login(page, join(root, "data"), host.origin);
      await navigation();
      await expect
        .poll(() => host.store.list("project")[0].autoIconId)
        .not.toBe(auto);
      await page.getByRole("button", { name: "Focus", exact: true }).click();
      await expect(
        page
          .getByRole("button", { name: "Set icon for Renamed project" })
          .locator("img"),
      ).toHaveAttribute("src", manual!);
      await page
        .getByRole("button", {
          name: "Actions for project Renamed project",
          exact: true,
        })
        .click();
      await page.getByRole("menuitem", { name: "Remove manual icon" }).click();
      await expect(
        page
          .getByRole("button", { name: "Set icon for Renamed project" })
          .locator("img"),
      ).not.toHaveAttribute("src", auto!);
      await writeFile(join(project, ".dsh/icon.svg"), "not an image");
      await host.execute(
        {
          v: 1,
          id: crypto.randomUUID(),
          createdAt: new Date().toISOString(),
          type: "project.discoverIcon",
          payload: { projectId: host.store.list("project")[0].id },
        },
        "fixture-client",
      );
      await expect(
        page
          .getByRole("button", { name: "Set icon for Renamed project" })
          .locator("img"),
      ).toHaveCount(0);
      await page
        .getByRole("button", {
          name: "Actions for project Renamed project",
          exact: true,
        })
        .click();
      await page
        .getByRole("menuitem", { name: "Rename project / workspaces…" })
        .click();
      await dialog
        .getByRole("button", { name: "Remove workspace Worktree" })
        .click();
      await expect(
        dialog.getByRole("button", { name: "Remove workspace Worktree" }),
      ).toHaveCount(0);
      await page.keyboard.press("Escape");
      await sections(page);
      await dialog
        .getByRole("button", { name: "Delete section Focus" })
        .click();
      await expect
        .poll(() => host.store.list("project")[0].sectionId)
        .toBe(null);
      await page.keyboard.press("Escape");
      await page
        .getByRole("button", {
          name: "Actions for project Renamed project",
          exact: true,
        })
        .click();
      await page.getByRole("menuitem", { name: "Remove from Suri…" }).click();
      await page.getByRole("menuitem", { name: "Confirm remove" }).click();
      await expect(
        page.getByRole("button", { name: "Set icon for Renamed project" }),
      ).toHaveCount(0);
      expect(await readFile(join(project, "keep.jsonl"), "utf8")).toBe(
        "synthetic history retained",
      );
      expect(host.store.list("project")).toHaveLength(1);
      expect(host.store.list("workspace")).toHaveLength(2);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
    } finally {
      await host.close();
      await rm(root, { recursive: true, force: true });
    }
  });

test("sections and project drag ordering persist with search and pinned grouping", async ({
  page,
}) => {
  const { browserHost } = await import("../support/browser-host.js");
  const fixture = await browserHost();
  try {
    const other = join(fixture.root, "Other");
    await mkdir(other);
    await fixture.login(page);
    await page
      .getByRole("button", { name: "Add project", exact: true })
      .click();
    const dialog = page.getByRole("dialog");
    await chooseFolder(page, other);
    await expect(dialog).toHaveCount(0);
    await sections(page);
    for (const name of ["Alpha", "Beta"]) {
      await dialog
        .getByRole("textbox", { name: "New section name" })
        .fill(name);
      await dialog.getByRole("button", { name: "Create section" }).click();
      await expect(
        dialog.getByRole("textbox", {
          name: `Section name ${name}`,
          exact: true,
        }),
      ).toBeVisible();
    }
    await dialog
      .getByRole("textbox", { name: "Section name Beta", exact: true })
      .fill("Later");
    await dialog
      .getByRole("textbox", { name: "Section name Beta", exact: true })
      .press("Enter");
    await expect(
      dialog.getByRole("textbox", { name: "Section name Later", exact: true }),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    const section = (name: string) =>
      page.locator(".sidebar-section").filter({
        has: page.getByRole("button", { name, exact: true }),
      });
    const project = (name: string) =>
      page.locator(".project").filter({
        has: page.getByRole("button", {
          name: `Set icon for ${name}`,
          exact: true,
        }),
      });
    await page
      .getByRole("button", { name: "View options", exact: true })
      .click();
    await page
      .getByRole("menuitemradio", { name: "Manual", exact: true })
      .click();
    await page.keyboard.press("Escape");
    await project("Other").locator(".project-row").dragTo(section("Alpha"));
    await expect(section("Alpha")).toContainText("Other");
    await project("workspace")
      .locator(".project-row")
      .dragTo(project("Other").locator(".project-row"), {
        targetPosition: { x: 50, y: 2 },
      });
    await expect(section("Alpha").locator(".project-row > span")).toHaveText([
      "workspace",
      "Other",
    ]);
    await project("Other")
      .locator(".project-row")
      .dragTo(project("workspace").locator(".project-row"), {
        targetPosition: { x: 50, y: 2 },
      });
    await expect(section("Alpha").locator(".project-row > span")).toHaveText([
      "Other",
      "workspace",
    ]);
    await page
      .getByRole("button", { name: "Later", exact: true })
      .dragTo(page.getByRole("button", { name: "Alpha", exact: true }));
    await expect(page.locator(".section-heading")).toHaveText([
      "Pinned",
      "Projects",
      "Later",
      "Alpha",
    ]);
    await page
      .getByRole("textbox", { name: "Filter projects and sessions" })
      .fill("Browser fixture");
    await expect(project("workspace")).toBeVisible();
    await expect(project("Other")).toHaveCount(0);
    await page
      .getByRole("textbox", { name: "Filter projects and sessions" })
      .fill("");
    await fixture.restart(page);
    await expect(section("Alpha").locator(".project-row > span")).toHaveText([
      "Other",
      "workspace",
    ]);
    await expect(page.locator(".section-heading")).toHaveText([
      "Pinned",
      "Projects",
      "Later",
      "Alpha",
    ]);
  } finally {
    await fixture.close();
  }
});
