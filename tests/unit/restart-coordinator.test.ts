import { test, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { RestartCoordinator } from "../../apps/host/src/restart-coordinator.js";
import { RestartHandoffs } from "../../apps/host/src/restart-handoff.js";

test("approval is exact-target, idle-gated, checkpointed, cancelled on changed target and single-dispatch", async () => {
  const root = await mkdtemp(join(tmpdir(), "suri-restart-owner-"));
  let work = 1,
    now = 1000,
    dispatched = 0;
  let target = { buildId: "b".repeat(64), generation: 1 };
  const client = randomUUID();
  const hooks = {
    instanceId: randomUUID(),
    profileId: randomUUID(),
    origin: () => "http://127.0.0.1:9001",
    target: () => target,
    uiBuildId: () => "b".repeat(64),
    work: () => ({
      count: work,
      blockers: work ? [{ kind: "commands", count: work }] : [],
    }),
    clients: () => [client],
    preflight: async () => {},
    dispatch: async () => {
      dispatched++;
    },
    handoffs: new RestartHandoffs(root, () => now),
  };
  const owner = await new RestartCoordinator(root, hooks, () => now).load();
  try {
    await expect(owner.approve(target.buildId, "now", 1)).rejects.toMatchObject(
      { code: "HOST_BUSY" },
    );
    await owner.approve(target.buildId, "when-idle", 1);
    await owner.tick();
    expect(dispatched).toBe(0);
    work = 0;
    await owner.tick();
    expect(owner.snapshot().approval?.phase).toBe("checkpoints");
    const firstBarrier = owner.snapshot().approval!.barrierId!;
    work = 1;
    await owner.tick();
    expect(owner.snapshot().approval?.phase).toBe("checkpoints");
    work = 0;
    now += 5001;
    await owner.tick();
    expect(owner.snapshot().approval?.code).toBe("CLIENT_STATE_UNSAVED");
    await owner.tick();
    const operation = owner.snapshot().approval!;
    expect(operation.barrierId).not.toBe(firstBarrier);
    expect(() =>
      owner.acknowledge(operation.operationId, client, firstBarrier),
    ).toThrow("RESTART_BARRIER_CLOSED");
    owner.acknowledge(operation.operationId, client, operation.barrierId!);
    await owner.tick();
    expect(dispatched).toBe(1);
    await owner.tick();
    expect(dispatched).toBe(1);
    await owner.prepareAdmission(
      operation.operationId,
      hooks.instanceId,
      target.buildId,
    );
    work = 1;
    await owner.busyAdmission();
    expect(owner.snapshot().approval?.phase).toBe("waiting");
    target = { buildId: "c".repeat(64), generation: 2 };
    await owner.tick();
    expect(owner.snapshot().approval?.phase).toBe("cancelled");
    await owner.approve(target.buildId, "when-idle", 2);
    const replacement = await new RestartCoordinator(
      root,
      { ...hooks, instanceId: randomUUID() },
      () => now,
    ).load();
    expect(replacement.snapshot().approval?.phase).toBe("cancelled");
    await replacement.stop();
  } finally {
    await owner.stop();
    await rm(root, { recursive: true, force: true });
  }
});
