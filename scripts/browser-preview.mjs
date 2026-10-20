// A preview serves an immutable asset copy. Restart retains the same catalog,
// workspace and port; compilation alone never updates an open preview.
import { browserHost } from "../dist/tests/support/browser-host.js";
import { startHost } from "../dist/apps/host/src/host.js";
import { control } from "../dist/apps/host/src/cli.js";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { homedir } from "node:os";

const pointer = ".suri-local/browser-preview-root";
// Usage: npm run preview               start a synthetic preview
//        npm run preview:open          start it and open it in the browser
//        npm run preview -- --open     open an already running preview
//        npm run preview -- --resume   restart a stopped preview, same data
const launch = process.argv[2] === "--launch";
const mode = launch ? undefined : process.argv[2];
const savedRoot = async () => (await readFile(pointer, "utf8")).trim();
async function openPreview(data) {
  const bootstrap = await control(data, { type: "bootstrap" });
  // The bootstrap nonce is short-lived and single-use.
  const url = `${bootstrap.origin}/#nonce=${bootstrap.nonce}`;
  console.log(`Open this URL in a browser if none opens: ${url}`);
  const opener =
    process.platform === "darwin"
      ? "/usr/bin/open"
      : process.platform === "linux"
        ? "xdg-open"
        : undefined;
  if (opener) {
    const child = spawn(opener, [url], { stdio: "ignore" });
    child.on("error", () => {});
    child.unref();
  }
}
if (mode === "--open") {
  await openPreview(await savedRoot());
} else {
  const assets = resolve(".suri-local/browser-builds", randomUUID());
  await cp(resolve("dist/ui"), assets, { recursive: true, errorOnExist: true });
  let host;
  let data;
  if (mode === "--restart" || mode === "--resume") {
    data = await savedRoot();
    if (
      basename(data) !== "data" ||
      !basename(dirname(data)).startsWith("suri-browser-")
    )
      throw Error(
        "This command only resumes a Suri synthetic browser preview.",
      );
    const endpoint = JSON.parse(
      await readFile(join(data, "run/endpoint.json"), "utf8"),
    );
    if (mode === "--restart") {
      const b = await control(data, { type: "bootstrap" });
      const response = await fetch(`${b.origin}/v1/bootstrap`, {
        method: "POST",
        headers: { Origin: b.origin, "Content-Type": "application/json" },
        body: JSON.stringify({ nonce: b.nonce }),
      });
      const auth = await response.json();
      const headers = {
        Origin: b.origin,
        Cookie: response.headers.get("set-cookie").split(";")[0],
        "X-Suri-Csrf": auth.csrf,
        "Content-Type": "application/json",
      };
      const command = async (type, payload = {}) =>
        (
          await fetch(`${b.origin}/v1/commands`, {
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
      if (!health.result?.validation)
        throw Error("Refusing to restart a non-preview host.");
      const controlHealth = await control(data, { type: "health" });
      const stopped = await command("host.shutdown", {
        expectedInstanceId: controlHealth.instanceId,
      });
      if (stopped.status !== "completed")
        throw Error(stopped.error?.message ?? "Preview could not stop.");
      let stoppedListening = false;
      for (let attempt = 0; attempt < 50; attempt++) {
        await new Promise((r) => setTimeout(r, 100));
        try {
          await control(data, { type: "health" });
        } catch {
          stoppedListening = true;
          break;
        }
      }
      if (!stoppedListening)
        throw Error("The preview is still stopping. Its data was retained.");
    }
    host = await startHost({
      root: data,
      assets,
      helper: resolve("dist/native/suri-helper"),
      validation: true,
      simulated: true,
      port: Number(new URL(endpoint.origin).port),
    });
  } else {
    if (mode) throw Error("Use --open, --restart or --resume.");
    const fixture = await browserHost(assets, homedir());
    host = fixture.host;
    data = fixture.data;
    await mkdir(".suri-local", { recursive: true });
    await writeFile(pointer, data);
  }
  if (launch) await openPreview(data);
  console.log(
    launch
      ? "Synthetic preview ready with a fixed UI build."
      : "Synthetic preview ready with a fixed UI build. Open it with npm run preview -- --open from another terminal.",
  );
  console.log(
    "Ctrl-C stops this preview and retains its catalog and workspace. Resume with npm run preview -- --resume.",
  );
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    await host.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void close());
  process.on("SIGTERM", () => void close());
}
