import { spawn } from "node:child_process";
import { mkdir, readFile, rm } from "node:fs/promises";
import { closeSync, openSync } from "node:fs";
import { join, resolve } from "node:path";
import { platform } from "node:os";
import { randomUUID } from "node:crypto";
import { launchRetained } from "./retained-hosts.js";
import {
  classifyStartupError,
  preflight,
  startupFailure,
  startupStatusPath,
  type StartupFailure,
} from "./preflight.js";
import { prepareLocalRelease } from "./local-release.js";
import { assets, CliFailure, fail, helper, repo, root } from "./cli-env.js";
import { assertCompatibleHealth, control } from "./cli-control.js";

export async function resolveLaunchFailure(
  statusPath: string,
  childFailure?: StartupFailure,
): Promise<StartupFailure | undefined> {
  try {
    const text = await readFile(statusPath, "utf8");
    let detail: StartupFailure;
    try {
      detail = JSON.parse(text) as StartupFailure;
      if (
        detail?.ok !== false ||
        typeof detail.stage !== "string" ||
        typeof detail.code !== "string" ||
        typeof detail.retryable !== "boolean" ||
        typeof detail.action !== "string"
      )
        throw new Error("invalid startup status");
    } catch {
      return startupFailure(
        "child",
        "STARTUP_STATUS_INVALID",
        false,
        "Do not retry this launch until the status-channel writer is repaired.",
      );
    } finally {
      await rm(statusPath, { force: true });
    }
    return detail;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT")
      return childFailure;
    return startupFailure(
      "child",
      "STARTUP_STATUS_UNREADABLE",
      false,
      "Check the private run-directory permissions before retrying.",
    );
  }
}

export async function ensure() {
  try {
    const health = await control(root, { type: "health" });
    assertCompatibleHealth(health);
    return;
  } catch (error) {
    if (
      error instanceof CliFailure &&
      error.detail.code !== "CONTROL_UNAVAILABLE"
    )
      throw error;
  }
  try {
    if (await launchRetained(root, () => control(root, { type: "health" })))
      return;
  } catch (error) {
    const code =
      error instanceof Error &&
      "code" in error &&
      /^[A-Z_]{1,80}$/.test(String(error.code))
        ? String(error.code)
        : "HOST_RETAINED_LAUNCH_FAILED";
    fail(
      "readiness",
      code,
      false,
      "The retained host did not start. Inspect the reported stage; no mutable-checkout fallback was attempted.",
    );
  }
  const checked = await preflight({ assets, helper });
  if (!checked.ok) throw new CliFailure(checked);
  let release: Awaited<ReturnType<typeof prepareLocalRelease>>;
  try {
    release = await prepareLocalRelease({
      packageRoot: repo,
      dataRoot: root,
    });
  } catch (error) {
    if (
      error instanceof Error &&
      error.name === "LocalReleaseError" &&
      /^[A-Z_]+$/.test(error.message)
    )
      throw new CliFailure(
        startupFailure(
          "assets",
          error.message,
          false,
          "Keep the active release unchanged and reinstall the reviewed Local artifact.",
        ),
      );
    const fsCode =
      error &&
      typeof error === "object" &&
      "code" in error &&
      ["ENOENT", "EACCES", "EPERM", "ENOTDIR", "EISDIR"].includes(
        String(error.code),
      )
        ? String(error.code)
        : "INTERNAL";
    throw new CliFailure(
      startupFailure(
        "assets",
        `RELEASE_PREPARATION_${fsCode}`,
        false,
        "Keep the active release unchanged and inspect the matching release preparation stage.",
      ),
    );
  }
  await mkdir(join(root, "run"), { recursive: true, mode: 0o700 });
  const launchId = randomUUID();
  const statusPath = startupStatusPath(root, launchId);
  const log =
    platform() === "linux"
      ? openSync(join(root, "run/host.log"), "a", 0o600)
      : undefined;
  const child = spawn(process.execPath, [release.cli, "serve"], {
    // The detached host outlives app/checkout replacement. Its cwd must not.
    cwd: resolve(root),
    detached: true,
    stdio: log === undefined ? "ignore" : ["ignore", log, log],
    env: {
      ...process.env,
      SURI_STARTUP_STATUS: statusPath,
      SURI_IMMUTABLE_RELEASE: release.immutable ? "1" : "0",
    },
  });
  let childFailure: StartupFailure | undefined;
  child.once("error", () => {
    childFailure = startupFailure(
      "child",
      "CHILD_SPAWN_FAILED",
      true,
      "Verify the immutable Suri CLI executable and retry once.",
    );
  });
  child.once("exit", () => {
    childFailure ??= classifyStartupError("child");
  });
  child.unref();
  if (log !== undefined) closeSync(log);
  for (let i = 0; i < 50; i++) {
    await new Promise((r) => setTimeout(r, 100));
    try {
      const health = await control(root, { type: "health" });
      assertCompatibleHealth(health);
      await rm(statusPath, { force: true });
      return;
    } catch (error) {
      if (
        error instanceof CliFailure &&
        error.detail.code !== "CONTROL_UNAVAILABLE"
      )
        throw error;
    }
    const launchFailure = await resolveLaunchFailure(statusPath, childFailure);
    if (launchFailure) throw new CliFailure(launchFailure);
  }
  fail(
    "readiness",
    "HOST_READINESS_TIMEOUT",
    true,
    "Confirm no incompatible Suri host owns this profile, then retry once.",
  );
}
