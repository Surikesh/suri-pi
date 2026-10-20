// Production-shaped WKWebView acceptance, isolated synthetic catalog only.
// Run after npm run build && npm run package:macos.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { browserHost } from "../dist/tests/support/browser-host.js";
import { control } from "../dist/apps/host/src/cli.js";

const fixture = await browserHost();
let shell;
try {
  const prefs = await fixture.execute("preferences.get");
  await fixture.execute(
    "preferences.patch",
    {
      patch: { navigationGroup: "list" },
    },
    undefined,
    prefs.revision,
  );
  const projectPath = join(fixture.root, "Icon project");
  await mkdir(join(projectPath, ".dsh"), { recursive: true });
  await writeFile(
    join(projectPath, ".dsh/icon.svg"),
    '<svg xmlns="http://www.w3.org/2000/svg" width="60" height="60"><rect width="60" height="60" rx="12" fill="#526add"/></svg>',
  );
  const grant = await control(fixture.data, {
    type: "grant",
    kind: "directory",
    path: projectPath,
  });
  const project = await fixture.execute("project.add", {
    directoryGrantId: grant.grantId,
  });
  const workspace = fixture.host.store
    .list("workspace")
    .find((w) => w.projectId === project.id);
  assert.ok(workspace);
  await fixture.execute("session.create", {
    workspaceId: workspace.id,
    runtimeId: fixture.runtime.id,
    name: "Native icon fixture",
  });
  const report = join(fixture.root, "navigation.json");
  shell = spawn(
    resolve(".build/Suri Pi.app/Contents/MacOS/SuriPi"),
    ["-ApplePersistenceIgnoreState", "YES", "--navigation-diagnostics", report],
    {
      env: { ...process.env, SURI_DATA_DIR: fixture.data },
      stdio: "ignore",
    },
  );
  let evidence;
  for (let attempt = 0; attempt < 200; attempt++) {
    try {
      const candidate = JSON.parse(await readFile(report, "utf8"));
      await readFile(join(fixture.root, "navigation.png"));
      evidence = candidate;
      break;
    } catch {
      // Evidence not written yet: poll again.
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!evidence) {
    let diagnostic = "no-report";
    try {
      diagnostic = await readFile(report, "utf8");
    } catch {
      // The report is optional: diagnostic keeps its no-report default.
    }
    throw new Error(
      `WKWebView evidence timeout; shellExit=${shell.exitCode}; boundedReport=${diagnostic}`,
    );
  }
  assert.equal(evidence.path, "/");
  assert.equal(evidence.ready, true);
  assert.equal(evidence.list, true);
  assert.equal(evidence.icons, 2);
  assert.equal(evidence.imageCount, 1);
  assert.equal(evidence.folderCount, 1);
  assert.equal(evidence.asset, "200");
  assert.ok(
    evidence.samples.every(
      (s) => s.width > 0 && s.height > 0 && s.visibility === "visible",
    ),
  );
  assert.ok(
    evidence.samples
      .filter((s) => s.image)
      .every((s) => s.image.complete && s.image.width > 0),
  );
  await mkdir(".suri-local/diagnostics", { recursive: true });
  await writeFile(
    ".suri-local/diagnostics/native-list-fixture.json",
    JSON.stringify(evidence, null, 2),
  );
  await writeFile(
    ".suri-local/diagnostics/native-list-fixture.png",
    await readFile(join(fixture.root, "navigation.png")),
  );
  console.log(
    "Native WKWebView list: raster icon + folder fallback + authenticated asset passed.",
  );
} finally {
  if (shell && shell.exitCode === null) {
    shell.kill("SIGTERM");
    await new Promise((resolve) => shell.once("exit", resolve));
  }
  await fixture.close();
}
