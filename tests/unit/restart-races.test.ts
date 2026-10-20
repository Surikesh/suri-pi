import { test, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { RestartCoordinator } from "../../apps/host/src/restart-coordinator.js";
import { RestartHandoffs } from "../../apps/host/src/restart-handoff.js";

async function fixture(preflight = async () => {}) {
  const root = await mkdtemp(join(tmpdir(), "suri-restart-race-"));
  let now = 1000,
    dispatched = 0;
  const target = { buildId: "a".repeat(64), generation: 1 };
  const owner = await new RestartCoordinator(
    root,
    {
      instanceId: randomUUID(),
      profileId: randomUUID(),
      origin: () => "http://127.0.0.1:9001",
      target: () => target,
      uiBuildId: () => "b".repeat(64),
      clients: () => [],
      work: () => ({ count: 0, blockers: [] }),
      preflight,
      dispatch: async () => {
        dispatched++;
      },
      handoffs: new RestartHandoffs(root, () => now),
    },
    () => now,
  ).load();
  return {
    owner,
    target,
    dispatched: () => dispatched,
    advance: (ms: number) => {
      now += ms;
    },
    async close() {
      await owner.stop();
      await rm(root, { recursive: true, force: true });
    },
  };
}
test("same bytes with a new generation and expired approval cannot inherit permission", async () => {
  const f = await fixture();
  try {
    await f.owner.approve(f.target.buildId, "when-idle", 1);
    f.target.generation++;
    await f.owner.tick();
    expect(f.owner.snapshot().approval).toMatchObject({
      phase: "cancelled",
      code: "HOST_TARGET_CHANGED",
    });
    await f.owner.approve(f.target.buildId, "when-idle", 2);
    f.advance(24 * 3600_000 + 1);
    await f.owner.tick();
    expect(f.owner.snapshot().approval).toMatchObject({
      phase: "cancelled",
      code: "RESTART_APPROVAL_EXPIRED",
    });
    expect(f.dispatched()).toBe(0);
  } finally {
    await f.close();
  }
});
test("cancel/reapprove during preflight isolates the new operation from old failures", async () => {
  let enter!: () => void,
    release!: () => void,
    first = true;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const f = await fixture(async () => {
    if (first) {
      first = false;
      enter();
      await released;
      throw Error("old preflight failed");
    }
  });
  try {
    await f.owner.approve(f.target.buildId, "when-idle", 1);
    const old = f.owner.snapshot().approval!.operationId;
    const pending = f.owner.tick();
    await entered;
    await f.owner.cancel(old);
    await f.owner.approve(f.target.buildId, "when-idle", 1);
    const fresh = f.owner.snapshot().approval!.operationId;
    expect(fresh).not.toBe(old);
    release();
    await pending;
    expect(f.owner.snapshot().approval).toMatchObject({
      operationId: fresh,
      phase: "waiting",
    });
    expect(f.dispatched()).toBe(0);
    await f.owner.tick();
    expect(f.dispatched()).toBe(1);
    f.advance(60001);
    await f.owner.tick();
    expect(f.owner.snapshot().approval).toMatchObject({
      operationId: fresh,
      phase: "failed",
      code: "RESTART_WORKER_TIMEOUT",
    });
    await f.owner.tick();
    expect(f.dispatched()).toBe(1);
  } finally {
    release();
    await f.close();
  }
});
