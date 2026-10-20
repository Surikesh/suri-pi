import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import {
  RuntimeValidator,
  assertSessionProfile,
} from "../../apps/host/src/runtime-validation.js";
import { Storage } from "../../apps/host/src/storage.js";

const profile = (agentDir: string) => ({
  provider: "fixture-provider",
  model: "fixture-model",
  agentDir,
});

describe("validation profile matches the session profile", () => {
  const saved = process.env.PI_CODING_AGENT_DIR;
  const roots: string[] = [];
  afterEach(async () => {
    if (saved === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = saved;
    await Promise.all(
      roots.splice(0).map((r) => rm(r, { recursive: true, force: true })),
    );
  });

  test("sessions inherit PI_CODING_AGENT_DIR, defaulting to ~/.pi/agent", () => {
    expect(() =>
      assertSessionProfile(profile(join(homedir(), ".pi", "agent")), {}),
    ).not.toThrow();
    expect(() => assertSessionProfile(profile("/srv/other"), {})).toThrow();
  });

  test("accepts only the profile sessions use", () => {
    const env = { PI_CODING_AGENT_DIR: "/srv/pi-profile" };
    expect(() =>
      assertSessionProfile(profile("/srv/pi-profile/"), env),
    ).not.toThrow();
    expect(() => assertSessionProfile(profile("/srv/other"), env)).toThrow(
      expect.objectContaining({ code: "RUNTIME_VALIDATION_PROFILE_MISMATCH" }),
    );
  });

  test("expands ~ like Pi, ignores a trailing slash and follows symlink aliases", async () => {
    const home = join(homedir(), ".pi", "agent");
    expect(() =>
      assertSessionProfile(profile(home), {
        PI_CODING_AGENT_DIR: "~/.pi/agent",
      }),
    ).not.toThrow();
    expect(() =>
      assertSessionProfile(profile(homedir()), { PI_CODING_AGENT_DIR: "~" }),
    ).not.toThrow();
    expect(() => assertSessionProfile(profile(`${home}/`), {})).not.toThrow();
    const root = await mkdtemp(join(tmpdir(), "suri-profile-alias-"));
    roots.push(root);
    await mkdir(join(root, "real"));
    await symlink(join(root, "real"), join(root, "alias"));
    expect(() =>
      assertSessionProfile(profile(join(root, "real")), {
        PI_CODING_AGENT_DIR: join(root, "alias"),
      }),
    ).not.toThrow();
    expect(() =>
      assertSessionProfile(profile(join(root, "real", "other")), {
        PI_CODING_AGENT_DIR: join(root, "alias"),
      }),
    ).toThrow(
      expect.objectContaining({ code: "RUNTIME_VALIDATION_PROFILE_MISMATCH" }),
    );
  });

  test("accepts a file:// agent directory like Pi", () => {
    const dir = join(tmpdir(), "suri-profile-url");
    expect(() =>
      assertSessionProfile(profile(dir), {
        PI_CODING_AGENT_DIR: pathToFileURL(dir).href,
      }),
    ).not.toThrow();
  });

  test("rejects relative directories instead of resolving them against a cwd", () => {
    const relative = expect.objectContaining({
      code: "RUNTIME_VALIDATION_PROFILE_RELATIVE",
    });
    expect(() =>
      assertSessionProfile(profile(join(process.cwd(), "agent")), {
        PI_CODING_AGENT_DIR: "agent",
      }),
    ).toThrow(relative);
    expect(() =>
      assertSessionProfile(profile("agent"), {
        PI_CODING_AGENT_DIR: join(process.cwd(), "agent"),
      }),
    ).toThrow(relative);
  });

  test("real acceptance rejects a profile that sessions would not use before spawning Pi", async () => {
    process.env.PI_CODING_AGENT_DIR = "/srv/pi-profile";
    const root = await mkdtemp(join(tmpdir(), "suri-profile-store-"));
    roots.push(root);
    const store = new Storage(root);
    try {
      store.put("runtime", {
        id: "r1",
        executable: "/nonexistent/pi",
        version: "0.85.1",
        identity: "candidate-identity",
        status: "candidate",
        revision: 0,
      });
      await expect(
        new RuntimeValidator().validateAndPromote(
          store,
          "r1",
          profile("/srv/unused-profile"),
        ),
      ).rejects.toMatchObject({ code: "RUNTIME_VALIDATION_PROFILE_MISMATCH" });
    } finally {
      store.close();
    }
  });
});
