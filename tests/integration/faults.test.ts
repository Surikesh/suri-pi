import { it, expect } from "vitest";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { startHost } from "../../apps/host/src/host.js";
import { acquireLock } from "../../apps/host/src/resources.js";
import { Storage } from "../../apps/host/src/storage.js";
const helper = resolve("dist/native/suri-helper"),
  assets = resolve("dist/ui");
async function provesReleased(root: string) {
  const lock = await acquireLock(helper, join(root, "run/host.lock"));
  lock.stdin.end();
  await new Promise((r) => lock.once("exit", r));
}
it("corrupt storage refuses startup, preserves bytes and releases its OS lock", async () => {
  const root = await mkdtemp(join(tmpdir(), "suri-corrupt-"));
  try {
    const bytes = Buffer.from("synthetic invalid sqlite");
    await writeFile(join(root, "state.sqlite"), bytes);
    await expect(startHost({ root, helper, assets })).rejects.toThrow();
    await provesReleased(root);
    expect(await readFile(join(root, "state.sqlite"))).toEqual(bytes);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
it("a failed listener releases ownership without stopping the other host", async () => {
  const root = await mkdtemp(join(tmpdir(), "suri-listen-")),
    other = await mkdtemp(join(tmpdir(), "suri-listen-"));
  const host = await startHost({ root, helper, assets });
  try {
    await expect(
      startHost({
        root: other,
        helper,
        assets,
        port: Number(new URL(host.origin).port),
      }),
    ).rejects.toThrow();
    await provesReleased(other);
    expect((await fetch(host.origin)).ok).toBe(true);
  } finally {
    await host.close();
    await rm(root, { recursive: true, force: true });
    await rm(other, { recursive: true, force: true });
  }
});
it("read-only storage failure leaves both event sequence and snapshot unchanged", async () => {
  const root = await mkdtemp(join(tmpdir(), "suri-readonly-"));
  const store = new Storage(root);
  try {
    store.event("session:fixture", "run.state", { phase: "idle" });
    store.db.pragma("query_only=ON");
    expect(() =>
      store.event("session:fixture", "run.state", { phase: "running" }),
    ).toThrow();
    expect(store.snapshot("session:fixture").seq).toBe(1);
    expect(store.snapshot("session:fixture").phase).toBe("idle");
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
