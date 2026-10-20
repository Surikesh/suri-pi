import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp } from "node:fs/promises";
import { afterEach, describe, expect, test } from "vitest";
import {
  classifyStartupError,
  preflight,
  startupStatusPath,
} from "../../apps/host/src/preflight.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function root() {
  const value = await mkdtemp(join(tmpdir(), "suri-preflight-"));
  roots.push(value);
  await mkdir(join(value, "ui"));
  return value;
}

describe("startup preflight", () => {
  test("categorizes a missing helper before native host imports", async () => {
    const directory = await root();
    const result = await preflight({
      assets: join(directory, "ui"),
      helper: join(directory, "missing-helper"),
      requireSupportedPlatform: false,
    });
    expect(result).toMatchObject({
      ok: false,
      stage: "helper",
      code: "HELPER_UNAVAILABLE",
      retryable: false,
    });
  });

  test("categorizes native module failures without implicit repair", async () => {
    const directory = await root();
    const helper = join(directory, "helper");
    await writeFile(helper, "#!/bin/sh\nexit 0\n");
    await chmod(helper, 0o700);
    const sqlite = await preflight({
      assets: join(directory, "ui"),
      helper,
      requireSupportedPlatform: false,
      sqliteLoader: async () => {
        throw new Error("synthetic-token");
      },
    });
    expect(sqlite).toMatchObject({
      stage: "sqlite",
      code: "SQLITE_ABI_UNAVAILABLE",
    });
    const pty = await preflight({
      assets: join(directory, "ui"),
      helper,
      requireSupportedPlatform: false,
      ptyLoader: async () => {
        throw new Error("synthetic-token");
      },
    });
    expect(pty).toMatchObject({ stage: "pty", code: "PTY_ABI_UNAVAILABLE" });
    expect(JSON.stringify({ sqlite, pty })).not.toContain("synthetic-token");
  });

  test.each([
    ["lock", "HOST_LOCK_UNAVAILABLE"],
    ["storage", "STORAGE_OPEN_FAILED"],
    ["listener", "LISTENER_BIND_FAILED"],
    ["child", "CHILD_EARLY_EXIT"],
    ["control", "CONTROL_INVALID_RESPONSE"],
  ] as const)("classifies the %s startup boundary", (stage, code) => {
    expect(classifyStartupError(stage)).toMatchObject({ stage, code });
  });

  test("isolates launch status by launch id", () => {
    expect(startupStatusPath("/tmp/profile", "launch-a")).not.toBe(
      startupStatusPath("/tmp/profile", "launch-b"),
    );
  });

  test("categorizes corrupt assets without exposing their path", async () => {
    const directory = await root();
    const helper = join(directory, "helper");
    await writeFile(helper, "#!/bin/sh\nexit 0\n");
    await chmod(helper, 0o700);
    const result = await preflight({
      assets: join(directory, "ui"),
      helper,
      requireSupportedPlatform: false,
    });
    expect(result).toMatchObject({
      ok: false,
      stage: "assets",
      code: "ASSET_MANIFEST_INVALID",
    });
    expect(JSON.stringify(result)).not.toContain(directory);
  });
});
