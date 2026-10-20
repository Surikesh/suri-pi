import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, readlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { control } from "../../apps/host/src/cli.js";

const exec = promisify(execFile);

test("bootstrap-running refuses to launch an absent host", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "suri-running-only-"));
  const data = join(temporary, "data");
  const cli = resolve("dist/apps/host/src/cli.js");
  await mkdir(data);
  try {
    await expect(
      exec(process.execPath, [cli, "bootstrap-running", "native-client"], {
        env: { ...process.env, SURI_DATA_DIR: data },
        timeout: 15000,
      }),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("CONTROL_UNAVAILABLE"),
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    await expect(control(data, { type: "health" })).rejects.toMatchObject({
      detail: { code: "CONTROL_UNAVAILABLE" },
    });
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

// macOS-only: `cli open` runs the product platform preflight, which rejects non-macOS with UNSUPPORTED_PLATFORM.
test.skipIf(process.platform !== "darwin")(
  "detached CLI host uses durable data root, not its replaceable launch cwd",
  async () => {
    const temporary = await mkdtemp(join(tmpdir(), "suri-host-cwd-"));
    const data = join(temporary, "data");
    const launch = join(temporary, "replaceable-app");
    const cli = resolve("dist/apps/host/src/cli.js");
    const env = { ...process.env, SURI_DATA_DIR: data };
    await mkdir(launch);
    try {
      await exec(process.execPath, [cli, "open", "--no-open"], {
        cwd: launch,
        env,
        timeout: 15000,
      });
      const before = await control(data, { type: "health" });
      const cwd =
        process.platform === "linux"
          ? await readlink(`/proc/${before.pid}/cwd`)
          : (
              await exec("/usr/sbin/lsof", [
                "-a",
                "-p",
                String(before.pid),
                "-d",
                "cwd",
                "-Fn",
              ])
            ).stdout
              .split("\n")
              .find((line) => line.startsWith("n"))
              ?.slice(1);
      expect(cwd).toBe(await realpath(data));
      await rm(launch, { recursive: true });
      expect(await control(data, { type: "health" })).toMatchObject({
        instanceId: before.instanceId,
        lifecycle: "running",
      });
    } finally {
      await exec(process.execPath, [cli, "shutdown"], {
        env,
        timeout: 15000,
      }).catch(() => {});
      // Do not erase a profile while its host still owns it.
      let running = false;
      for (let i = 0; i < 50; i++) {
        running = await control(data, { type: "health" }).then(
          () => true,
          () => false,
        );
        if (!running) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      if (running)
        throw Error("Temporary host did not stop; profile retained.");
      await rm(temporary, { recursive: true, force: true });
    }
  },
  30000,
);
