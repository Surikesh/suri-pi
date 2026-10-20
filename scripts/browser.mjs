// Development browser entry: your regular Suri data directory and real Pi runtimes.
// --restart is guarded and never signals a busy host; builds never change served assets.
import {
  cp,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { openBrowser } from "./open-browser.mjs";
import { startHost } from "../dist/apps/host/src/host.js";
import { control } from "../dist/apps/host/src/cli.js";

if (process.argv[2] === "--serve") {
  const [, , , root, assets, port, uiCheckout] = process.argv;
  const host = await startHost({
    root,
    assets,
    helper: resolve("dist/native/suri-helper"),
    port: Number(port) || undefined,
    uiCheckout,
  });
  process.on("SIGTERM", () => void host.close().then(() => process.exit(0)));
} else {
  const root =
    process.env.SURI_DATA_DIR ??
    join(homedir(), "Library/Application Support/Suri Pi");
  if (process.argv.includes("--restart"))
    throw Error(
      "LEGACY_RESTART_REMOVED: Build with npm run build:updates and use the in-product exact-target restart flow.",
    );
  let bootstrap;
  let openPath = "/";
  try {
    bootstrap = await control(root, { type: "bootstrap" });
  } catch {
    // No running host: bootstrap stays undefined and a host is started below.
  }
  let port = bootstrap ? Number(new URL(bootstrap.origin).port) : undefined;
  if (bootstrap) {
    const r = await fetch(bootstrap.origin + "/v1/bootstrap", {
      method: "POST",
      headers: { Origin: bootstrap.origin, "Content-Type": "application/json" },
      body: JSON.stringify({ nonce: bootstrap.nonce }),
    });
    const auth = await r.json();
    const headers = {
      Origin: bootstrap.origin,
      Cookie: r.headers.get("set-cookie").split(";")[0],
      "X-Suri-Csrf": auth.csrf,
      "Content-Type": "application/json",
    };
    const command = async (type, payload = {}) =>
      (
        await fetch(bootstrap.origin + "/v1/commands", {
          method: "POST",
          headers,
          body: JSON.stringify({
            v: 1,
            id: randomUUID(),
            createdAt: new Date().toISOString(),
            type,
            payload,
          }),
        })
      ).json();
    const health = await command("host.get");
    if (health.status !== "completed")
      throw Error("The existing host did not return its runtime mode.");
    const isolatedTestProfile =
      process.env.SURI_BROWSER_ISOLATED_TEST === "1" &&
      (await realpath(root)).startsWith((await realpath(tmpdir())) + sep);
    if (
      (health.result?.validation ||
        health.result?.runtimeMode === "simulated") &&
      !isolatedTestProfile
    )
      throw Error(
        "This is a test profile. Run the working browser without a test SURI_DATA_DIR.",
      );
    await control(root, { type: "associate-ui", path: resolve(".") });
    if (process.argv.includes("--reload-ui")) {
      const markerPath = resolve(".suri-local/live-browser.json");
      let marker;
      try {
        marker = JSON.parse(await readFile(markerPath, "utf8"));
      } catch {
        throw Error(
          "UI_RELOAD_UNAVAILABLE: Restart the browser host once to establish its verified live-assets marker.",
        );
      }
      const controlHealth = await control(root, { type: "health" });
      const liveRoot = resolve(".suri-local/live-builds");
      const assets = resolve(String(marker.assets ?? ""));
      if (
        marker.instanceId !== controlHealth.instanceId ||
        !assets.startsWith(liveRoot + "/")
      )
        throw Error(
          "HOST_IDENTITY_CHANGED: Refusing to replace assets for an unverified host.",
        );
      const stage = `${assets}.next-${randomUUID()}`;
      const prior = `${assets}.prior-${randomUUID()}`;
      await cp(resolve("dist/ui"), stage, { recursive: true });
      try {
        await rename(assets, prior);
        await rename(stage, assets);
      } catch (error) {
        // Best effort rollback: the original error is rethrown either way.
        await rename(prior, assets).catch(() => {});
        throw error;
      } finally {
        await rm(stage, { recursive: true, force: true });
        await rm(prior, { recursive: true, force: true });
      }
      openPath = "/";
    }
  }
  if (!bootstrap) {
    const assets = resolve(".suri-local/live-builds", randomUUID());
    await cp(resolve("dist/ui"), assets, {
      recursive: true,
      errorOnExist: true,
    });
    await mkdir(".suri-local", { recursive: true });
    const log = await open(".suri-local/live-browser.log", "a", 0o600);
    const child = spawn(
      process.execPath,
      [
        fileURLToPath(import.meta.url),
        "--serve",
        root,
        assets,
        String(port ?? 0),
        resolve("."),
      ],
      { detached: true, stdio: ["ignore", log.fd, log.fd] },
    );
    child.unref();
    await log.close();
    for (let i = 0; i < 100; i++) {
      await new Promise((r) => setTimeout(r, 100));
      try {
        bootstrap = await control(root, { type: "bootstrap" });
        break;
      } catch {
        // Host not ready yet: poll again.
      }
    }
    if (!bootstrap)
      throw Error(
        "The working host did not start. Its catalog is retained; check .suri-local/live-browser.log.",
      );
    const freshHealth = await control(root, { type: "health" });
    await writeFile(
      resolve(".suri-local/live-browser.json"),
      JSON.stringify({ instanceId: freshHealth.instanceId, assets }),
      { mode: 0o600 },
    );
  }
  if (!process.argv.includes("--no-open")) {
    // Never print or persist the launch nonce.
    const b = await control(root, { type: "bootstrap" });
    const separator = openPath.includes("?") ? "&" : "?";
    await openBrowser(
      `${b.origin}${openPath}${separator}_suri_reload=${Date.now()}#nonce=${b.nonce}`,
      {
        newTab: process.argv.includes("--new-tab"),
        checkpoint: async (clientInstanceId) =>
          (
            await control(root, {
              type: "browser-rendezvous",
              clientInstanceId,
            })
          ).checkpointed === true,
      },
    );
  }
  console.log(
    process.argv.includes("--reload-ui")
      ? "Updated Suri interface opened without interrupting active sessions or terminals."
      : "Suri browser is ready with your Suri data directory and registered Pi runtimes.",
  );
}
