import {
  mkdtemp,
  mkdir,
  writeFile,
  copyFile,
  chmod,
  realpath,
  rm,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { startHost } from "../../apps/host/src/host.js";
import { control } from "../../apps/host/src/cli.js";
import { expect, type Page } from "@playwright/test";
/** Resolves when the browser's model-catalog discovery (which resumes the
 * selected session's runtime) has answered; resolves anyway after 5 seconds. */
export function modelDiscovery(page: Page) {
  return page
    .waitForResponse(
      (response) =>
        response.url().endsWith("/v1/commands") &&
        Boolean(response.request().postData()?.includes('"model.list"')),
      { timeout: 5000 },
    )
    .then(() => undefined)
    .catch(() => undefined);
}
export async function browserHost(
  assets = resolve(process.env.SURI_E2E_UI_ASSETS ?? "dist/ui"),
  directoryHome?: string,
  validation = true,
) {
  const root = await mkdtemp(join(tmpdir(), "suri-browser-"));
  const workspacePath = join(root, "workspace"),
    data = join(root, "data"),
    runtime = join(root, "fake-pi");
  await mkdir(workspacePath);
  const workspace = await realpath(workspacePath);
  await mkdir(join(runtime, "dist"), { recursive: true });
  await writeFile(join(workspace, "hello.txt"), "first line\nsecond line\n");
  await writeFile(
    join(runtime, "package.json"),
    JSON.stringify({
      name: "@earendil-works/pi-coding-agent",
      version: "0.85.1",
      type: "module",
    }),
  );
  const executable = join(runtime, "dist/cli.mjs");
  await copyFile("tests/fixtures/fake-pi.mjs", executable);
  await chmod(executable, 0o755);
  const options = {
    root: data,
    assets,
    helper: resolve("dist/native/suri-helper"),
    validation,
    simulated: true,
    directoryHome: directoryHome ?? workspace,
  };
  let host = await startHost(options);
  const execute = async (
    type: string,
    payload: any = {},
    sessionId?: string,
    expectedRevision?: number,
  ) => {
    const receipt = await host.execute(
      {
        v: 1,
        id: randomUUID(),
        createdAt: new Date().toISOString(),
        type,
        payload,
        sessionId,
        expectedRevision,
      },
      "fixture-client",
    );
    if (receipt.status === "rejected") throw Error(receipt.error?.message);
    return receipt.result!;
  };
  const project = await execute("project.add", {
    directoryGrantId: (
      await control(data, { type: "grant", kind: "directory", path: workspace })
    ).grantId,
  });
  const rt = await execute("runtime.register", {
    executableGrantId: (
      await control(data, {
        type: "grant",
        kind: "executable",
        path: executable,
      })
    ).grantId,
    expectedVersion: "0.85.1",
  });
  const w = host.store.list("workspace")[0];
  const session = await execute("session.create", {
    workspaceId: w.id,
    runtimeId: rt.id,
  });
  await execute(
    "session.rename",
    { name: "Browser fixture" },
    session.id,
    session.revision,
  );
  async function login(page: Page, options: { settle?: boolean } = {}) {
    const b = await control(data, { type: "bootstrap" });
    const response = await page.request.post(`${host.origin}/v1/bootstrap`, {
      headers: {
        Origin: host.origin,
        "Content-Type": "application/json",
      },
      data: { nonce: b.nonce },
    });
    if (!response.ok())
      throw new Error(
        `Browser fixture bootstrap failed (${response.status()}).`,
      );
    await page.goto(host.origin);
    await page.evaluate((id) => {
      if (!localStorage.getItem("suri.selected"))
        localStorage.setItem("suri.selected", id);
    }, session.id);
    // Opening a session prefetches its model catalog, which resumes the runtime.
    const discovered = modelDiscovery(page);
    await page.reload();
    await expect(page.getByRole("status")).toContainText("Connected");
    await expect(
      page.getByRole("textbox", { name: "Message Pi" }),
    ).toBeEnabled();
    if (options.settle === false) return;
    // Submitting while the resume is still starting would be delivered as a
    // queued follow-up instead of a prompt, so wait for discovery to settle.
    await discovered;
    await expect(page.locator(".run-status")).not.toContainText("starting");
  }
  return {
    root,
    workspace,
    data,
    project,
    session,
    runtime: rt,
    workspaceId: w.id,
    execute,
    login,
    get host() {
      return host;
    },
    async restart(page: Page) {
      const port = Number(new URL(host.origin).port);
      await host.close();
      host = await startHost({ ...options, port });
      await login(page);
    },
    async close() {
      await host.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}
