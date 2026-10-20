import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "vitest";
import { control } from "../../apps/host/src/cli.js";
import { startHost } from "../../apps/host/src/host.js";

const deferred = () => {
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>((done) => {
    entered = done;
  });
  const blocked = new Promise<void>((done) => {
    release = done;
  });
  return {
    started,
    release,
    async claim() {
      entered();
      await blocked;
    },
  };
};

test("legacy migration closes protected-work admission before claim I/O yields", async () => {
  const root = await mkdtemp(join(tmpdir(), "legacy-admission-"));
  const claim = deferred();
  const host = await startHost({
    root,
    assets: resolve("dist/ui"),
    helper: resolve("dist/native/suri-helper"),
    migrationClaim: claim.claim,
  });
  try {
    const grant = await control(root, { type: "bootstrap" });
    const boot = await fetch(grant.origin + "/v1/bootstrap", {
      method: "POST",
      headers: { Origin: grant.origin, "Content-Type": "application/json" },
      body: JSON.stringify({ nonce: grant.nonce }),
    });
    const auth = (await boot.json()) as { csrf: string };
    const cookie = boot.headers.get("set-cookie")!.split(";")[0];
    const health = await control(root, { type: "health" });
    const status = await control(root, { type: "updates-status" });
    const operationId = randomUUID();
    const admission = control(root, {
      type: "legacy-migrate-admit",
      schema: 1,
      state: "admission-requested",
      operationId,
      expectedPid: health.pid,
      expectedInstanceId: health.instanceId,
      profileId: status.profileId,
      origin: host.origin,
      sourceBuildId: null,
      sourceProvenance: status.runningHost.provenance,
      targetBuildId: "a".repeat(64),
      uiBuildId: "b".repeat(64),
      expiresAt: Date.now() + 60_000,
    });
    await claim.started;
    const rejected = await fetch(host.origin + "/v1/commands", {
      method: "POST",
      headers: {
        Origin: host.origin,
        "Content-Type": "application/json",
        Cookie: cookie,
        "X-Suri-Csrf": auth.csrf,
      },
      body: JSON.stringify({
        v: 1,
        id: randomUUID(),
        createdAt: new Date().toISOString(),
        type: "project.add",
        payload: { directoryGrantId: randomUUID() },
      }),
    }).then((response) => response.json());
    expect(rejected).toMatchObject({
      status: "rejected",
      error: { code: "HOST_STOPPING" },
    });
    claim.release();
    await expect(admission).resolves.toMatchObject({ stopping: true });
  } finally {
    claim.release();
    await host.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("rejected persisted claim reopens legacy admission", async () => {
  const root = await mkdtemp(join(tmpdir(), "legacy-admission-rollback-"));
  const host = await startHost({
    root,
    assets: resolve("dist/ui"),
    helper: resolve("dist/native/suri-helper"),
    migrationClaim: async () => {
      throw Object.assign(Error("MIGRATION_APPROVAL_MISMATCH"), {
        code: "MIGRATION_APPROVAL_MISMATCH",
      });
    },
  });
  try {
    const health = await control(root, { type: "health" });
    const status = await control(root, { type: "updates-status" });
    await expect(
      control(root, {
        type: "legacy-migrate-admit",
        schema: 1,
        state: "admission-requested",
        operationId: randomUUID(),
        expectedPid: health.pid,
        expectedInstanceId: health.instanceId,
        profileId: status.profileId,
        origin: host.origin,
        sourceBuildId: null,
        sourceProvenance: status.runningHost.provenance,
        targetBuildId: "a".repeat(64),
        uiBuildId: "b".repeat(64),
        expiresAt: Date.now() + 60_000,
      }),
    ).rejects.toMatchObject({
      detail: { code: "MIGRATION_APPROVAL_MISMATCH" },
    });
    await expect(control(root, { type: "bootstrap" })).resolves.toMatchObject({
      origin: host.origin,
    });
  } finally {
    await host.close();
    await rm(root, { recursive: true, force: true });
  }
});
