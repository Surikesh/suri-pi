import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import {
  runtimeVersion,
  versionFailure,
} from "../../packages/pi-adapter/src/runtime-version.js";

test("classifies failures without exposing raw process output", () => {
  for (const [error, category] of [
    [{ stderr: "SECRET uv_cwd ENOENT" }, "working-directory-unavailable"],
    [{ stderr: "env: node: No such file or directory" }, "node-not-on-path"],
    [{ code: "ENOENT" }, "executable-not-found"],
    [{ code: "EACCES" }, "permission-denied"],
    [{ killed: true }, "timeout"],
    [{ code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" }, "output-limit"],
    [{ code: 17, stderr: "SECRET" }, "process-exit"],
  ] as const)
    expect(versionFailure(error)).toBe(category);
});

test("version subprocess survives an unlinked host cwd", async () => {
  const root = await mkdtemp(join(tmpdir(), "suri-version-cwd-"));
  try {
    const cwd = join(root, "replaced-app");
    const runtime = join(root, "runtime");
    await mkdir(cwd);
    await mkdir(runtime);
    const executable = join(runtime, "pi.mjs");
    await writeFile(
      executable,
      '#!/usr/bin/env node\nprocess.cwd(); console.log("0.85.1");\n',
      { mode: 0o755 },
    );
    const module = pathToFileURL(
      resolve("packages/pi-adapter/src/runtime-version.ts"),
    ).href;
    const script = `
      import { execFile } from 'node:child_process';
      import { promisify } from 'node:util';
      import { rmSync } from 'node:fs';
      import { runtimeVersion, versionFailure } from ${JSON.stringify(module)};
      process.chdir(${JSON.stringify(cwd)});
      rmSync(${JSON.stringify(cwd)}, { recursive: true });
      let legacy;
      try { await promisify(execFile)(${JSON.stringify(executable)}, ['--version']); }
      catch(error) { legacy = versionFailure(error); }
      const fixed = await runtimeVersion(${JSON.stringify(executable)}, ${JSON.stringify(runtime)});
      console.log(JSON.stringify({legacy,fixed}));
    `;
    const { stdout } = await promisify(execFile)(process.execPath, [
      "--input-type=module",
      "-e",
      script,
    ]);
    expect(JSON.parse(stdout)).toEqual({
      legacy: "working-directory-unavailable",
      fixed: { ok: true, version: "0.85.1" },
    });
    await writeFile(
      executable,
      '#!/usr/bin/env node\nconsole.log("private unexpected output");\n',
      { mode: 0o755 },
    );
    expect(await runtimeVersion(executable, runtime)).toEqual({
      ok: false,
      category: "unexpected-output",
    });
    await writeFile(
      executable,
      '#!/usr/bin/env node\nconsole.error("private error");process.exit(17);\n',
      { mode: 0o755 },
    );
    expect(await runtimeVersion(executable, runtime)).toEqual({
      ok: false,
      category: "process-exit",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
