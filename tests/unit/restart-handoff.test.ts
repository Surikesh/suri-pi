import { test, expect } from "vitest";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { RestartHandoffs } from "../../apps/host/src/restart-handoff.js";

test("restart verifier is private, identity-bound, expiring and consumed once across a cookie-sharing group", async () => {
  const root = await mkdtemp(join(tmpdir(), "suri-handoff-"));
  let now = 1000;
  try {
    await mkdir(join(root, "run"));
    const handoffs = new RestartHandoffs(root, () => now);
    const binding = {
      operationId: randomUUID(),
      fromInstanceId: randomUUID(),
      profileId: randomUUID(),
      targetBuildId: "a".repeat(64),
      origin: "http://127.0.0.1:9001",
    };
    const expected = { ...binding, instanceId: randomUUID() };
    const [one, two] = await Promise.all([
      handoffs.mint(binding, "client-a"),
      handoffs.mint(binding, "client-a"),
    ]);
    await expect(handoffs.consume(one, expected)).rejects.toMatchObject({
      code: "HANDOFF_IDENTITY_CHANGED",
    });
    await handoffs.bind(
      binding.operationId,
      binding.targetBuildId,
      expected.instanceId,
    );
    const disk = await readFile(
      join(root, "run/restart-handoffs.json"),
      "utf8",
    );
    expect(disk).not.toContain(one);
    expect(disk).not.toContain(two);
    for (const changed of [
      { instanceId: binding.fromInstanceId },
      { instanceId: randomUUID() },
      { targetBuildId: "b".repeat(64) },
      { profileId: randomUUID() },
      { origin: "http://localhost:9001" },
    ])
      await expect(
        handoffs.consume(one, { ...expected, ...changed }),
      ).rejects.toMatchObject({ code: "HANDOFF_IDENTITY_CHANGED" });
    const outcomes = await Promise.allSettled([
      handoffs.consume(one, expected),
      handoffs.consume(two, expected),
    ]);
    expect(outcomes.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    await expect(
      handoffs.isBound(
        binding.operationId,
        binding.targetBuildId,
        expected.instanceId,
      ),
    ).resolves.toBe(true);
    await expect(handoffs.consume(one, expected)).rejects.toMatchObject({
      code: "HANDOFF_INVALID",
    });
    const expiredBinding = { ...binding, operationId: randomUUID() };
    const expired = await handoffs.mint(expiredBinding, "client-b");
    now += 120001;
    await expect(handoffs.consume(expired, expected)).rejects.toMatchObject({
      code: "HANDOFF_EXPIRED",
    });
    const revokedBinding = { ...binding, operationId: randomUUID() };
    const revoked = await handoffs.mint(revokedBinding, "client-c");
    await handoffs.revoke(revokedBinding.operationId);
    await expect(handoffs.consume(revoked, expected)).rejects.toMatchObject({
      code: "HANDOFF_INVALID",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("restart commit is durable without browser bearers", async () => {
  const root = await mkdtemp(join(tmpdir(), "suri-headless-commit-"));
  try {
    await mkdir(join(root, "run"));
    const handoffs = new RestartHandoffs(root);
    const operationId = randomUUID();
    const targetBuildId = "a".repeat(64);
    const instanceId = randomUUID();
    let terminalWrites = 0;
    await handoffs.commit(operationId, targetBuildId, instanceId, async () => {
      terminalWrites++;
    });
    await expect(
      handoffs.isBound(operationId, targetBuildId, instanceId),
    ).resolves.toBe(true);
    await expect(handoffs.revoke(operationId)).resolves.toBe(false);
    await expect(
      handoffs.isBound(operationId, targetBuildId, instanceId),
    ).resolves.toBe(true);
    expect(terminalWrites).toBe(1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("terminal commit is serialized against consume and rolls binding back on report failure", async () => {
  const root = await mkdtemp(join(tmpdir(), "suri-handoff-commit-"));
  try {
    await mkdir(join(root, "run"));
    const handoffs = new RestartHandoffs(root);
    const binding = {
      operationId: randomUUID(),
      fromInstanceId: randomUUID(),
      profileId: randomUUID(),
      targetBuildId: "a".repeat(64),
      origin: "http://127.0.0.1:9001",
    };
    const expected = { ...binding, instanceId: randomUUID() };
    const secret = await handoffs.mint(binding, "client-a");
    let releaseReport!: () => void;
    const reportGate = new Promise<void>((resolve) => {
      releaseReport = resolve;
    });
    const commit = handoffs.commit(
      binding.operationId,
      binding.targetBuildId,
      expected.instanceId,
      async () => {
        await reportGate;
        throw Error("ENOSPC");
      },
    );
    const consume = handoffs.consume(secret, expected);
    const commitCheck = expect(commit).rejects.toThrow("ENOSPC");
    const consumeCheck = expect(consume).rejects.toMatchObject({
      code: "HANDOFF_IDENTITY_CHANGED",
    });
    releaseReport();
    await Promise.all([commitCheck, consumeCheck]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
