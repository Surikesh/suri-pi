import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";

const exec = promisify(execFile);

test("the removed browser restart path fails before touching a host", async () => {
  const data = await mkdtemp(join(tmpdir(), "suri-removed-restart-"));
  try {
    await expect(
      exec(
        process.execPath,
        [resolve("scripts/browser.mjs"), "--restart", "--no-open"],
        {
          cwd: resolve("."),
          env: { ...process.env, SURI_DATA_DIR: data },
          timeout: 30_000,
        },
      ),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("LEGACY_RESTART_REMOVED"),
    });
  } finally {
    await rm(data, { recursive: true, force: true });
  }
});
