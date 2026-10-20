import { createServer } from "node:net";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { startHost } from "../../apps/host/src/host.js";
import { control } from "../../apps/host/src/cli.js";
import { acquireLock } from "../../apps/host/src/resources.js";

const roots: string[] = [];
afterEach(async () =>
  Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  ),
);
async function root(prefix: string) {
  const value = await mkdtemp(join(tmpdir(), prefix));
  roots.push(value);
  return value;
}
const options = (root: string, port?: number) => ({
  root,
  assets: resolve("dist/ui"),
  helper: resolve("dist/native/suri-helper"),
  port,
});

describe("bounded startup feedback", () => {
  test("classifies a lock conflict without signalling the existing host", async () => {
    const data = await root("suri-start-lock-");
    const first = await startHost(options(data));
    try {
      await expect(startHost(options(data))).rejects.toMatchObject({
        detail: { stage: "lock", code: "HOST_LOCK_UNAVAILABLE" },
      });
      expect(await control(data, { type: "health" })).toMatchObject({
        instanceId: expect.any(String),
        lifecycle: "running",
      });
    } finally {
      await first.close();
    }
  });

  test("classifies storage open and listener bind failures", async () => {
    const storageRoot = await root("suri-start-storage-");
    await mkdir(join(storageRoot, "state.sqlite"));
    await expect(startHost(options(storageRoot))).rejects.toMatchObject({
      detail: { stage: "storage", code: "STORAGE_OPEN_FAILED" },
    });

    const firstRoot = await root("suri-start-listener-a-");
    const secondRoot = await root("suri-start-listener-b-");
    const first = await startHost(options(firstRoot));
    try {
      const port = Number(new URL(first.origin).port);
      await expect(startHost(options(secondRoot, port))).rejects.toMatchObject({
        detail: { stage: "listener", code: "HOST_ADDRESS_CONFLICT" },
      });
    } finally {
      await first.close();
    }
  });

  test("reports an overlong private socket before connection and releases the profile lock", async () => {
    const data = join(await root("suri-long-control-"), "x".repeat(110));
    await expect(startHost(options(data))).rejects.toMatchObject({
      detail: { stage: "control", code: "CONTROL_PATH_TOO_LONG" },
    });
    const release = await acquireLock(
      resolve("dist/native/suri-helper"),
      join(data, "run/host.lock"),
    );
    const exited = new Promise<void>((resolve) =>
      release.once("exit", () => resolve()),
    );
    release.stdin.end();
    await exited;
  });

  test("rejects malformed control responses with a bounded category", async () => {
    const data = await root("suri-start-control-");
    await mkdir(join(data, "run"), { recursive: true });
    const server = createServer((socket) => {
      socket.on("error", () => {});
      socket.once("data", () => socket.end("not-json\n"));
    });
    await new Promise<void>((resolve) =>
      server.listen(join(data, "run/control.sock"), resolve),
    );
    try {
      await expect(control(data, { type: "health" })).rejects.toMatchObject({
        detail: { stage: "control", code: "CONTROL_INVALID_RESPONSE" },
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
