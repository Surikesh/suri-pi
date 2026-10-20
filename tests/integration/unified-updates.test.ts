import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { UpdateCoordinator } from "../../apps/host/src/update-coordinator.js";
import { UpdateStateStore } from "../../apps/host/src/update-state.js";
import { atomicJson, digest } from "../../scripts/build-manifests.mjs";
import {
  canonicalJson,
  UiIdentitySchema,
} from "../../packages/protocol/src/updates.js";
import { writeFile } from "node:fs/promises";
import type { UpdateCheckpoint } from "../../packages/protocol/src/update-checkpoint.js";
import { startHost } from "../../apps/host/src/host.js";
import { resolve } from "node:path";
const checkpoint: UpdateCheckpoint = {
  schema: 1,
  selectedProjectId: null,
  selectedWorkspaceId: null,
  selectedSessionId: null,
  draft: {
    text: "retained unsent fixture",
    attachmentIds: [],
    revision: 0,
    outboxIds: [],
  },
  expandedIds: ["tool:1"],
  anchor: {
    messageId: "message:1",
    blockId: null,
    offset: 19,
    bottomFollow: false,
  },
  layout: { sidebarOpen: true, detailsOpen: false, focus: "composer" },
};
async function fixture(run: (root: string, buildId: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "suri-unified-updates-"));
  try {
    const bytes = "fixture";
    const identity = UiIdentitySchema.parse({
      schema: 1,
      kind: "ui",
      compatibility: {
        protocol: 1,
        hostMin: 2,
        hostMax: 2,
        checkpoint: 1,
        shellMin: 2,
      },
      entry: "entry.js",
      files: [
        {
          path: "entry.js",
          sha256: digest(bytes),
          bytes: bytes.length,
          executable: false,
        },
        {
          path: "index.html",
          sha256: digest(bytes),
          bytes: bytes.length,
          executable: false,
        },
      ],
    });
    const buildId = digest(canonicalJson(identity));
    const path = join(root, "ui-builds", buildId);
    await mkdir(path, { recursive: true });
    await writeFile(join(path, "index.html"), bytes);
    await writeFile(join(path, "entry.js"), bytes);
    await atomicJson(join(path, "manifest.json"), {
      buildId,
      identity,
      createdAt: new Date().toISOString(),
    });
    await atomicJson(join(path, "ready.json"), { schema: 1, buildId });
    await run(root, buildId);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
describe("unified update foundations (not browser/native acceptance)", () => {
  it("promotes only after exact checkpoint, navigation and ready receipt", async () =>
    fixture(async (root, buildId) => {
      const state = await UpdateStateStore.load(root);
      const hostId = randomUUID(),
        client = randomUUID(),
        auth = randomUUID();
      const updates = new UpdateCoordinator(root, state, hostId);
      updates.register(client, auth);
      const prepared = await updates.prepare(buildId, 0, client, auth);
      const operation = prepared.trial!.operationId;
      expect(prepared.activeUiId).toBeNull();
      await expect(
        updates.ready(operation, buildId, client, auth, 1, hostId, 0),
      ).rejects.toMatchObject({ code: "UPDATE_CONFLICT" });
      const saved = await updates.checkpoint(
        operation,
        client,
        auth,
        0,
        checkpoint,
      );
      expect(saved.activeUiId).toBeNull();
      await updates.activate(
        operation,
        buildId,
        client,
        auth,
        saved.revision,
        1,
      );
      await expect(
        updates.ready(operation, buildId, client, auth, 1, randomUUID(), 0),
      ).rejects.toMatchObject({ code: "UPDATE_CONFLICT" });
      const promoted = await updates.ready(
        operation,
        buildId,
        client,
        auth,
        1,
        hostId,
        0,
      );
      expect(promoted.activeUiId).toBe(buildId);
      expect(promoted.knownGood).toEqual([buildId]);
      expect((await UpdateStateStore.load(root)).snapshot()).toEqual(promoted);
      await expect(
        updates.ready(operation, buildId, client, auth, 1, hostId, 0),
      ).rejects.toMatchObject({ code: "UPDATE_CONFLICT" });
    }));
  it("quarantines interrupted/failed trials without promoting last-good", async () =>
    fixture(async (root, buildId) => {
      const state = await UpdateStateStore.load(root);
      const client = randomUUID(),
        auth = randomUUID();
      const updates = new UpdateCoordinator(root, state, randomUUID());
      updates.register(client, auth);
      const prepared = await updates.prepare(buildId, 0, client, auth);
      await expect(
        updates.prepare(buildId, prepared.revision, client, auth),
      ).rejects.toMatchObject({ code: "UPDATE_CONFLICT" });
      await expect(
        updates.checkpoint(
          prepared.trial!.operationId,
          client,
          randomUUID(),
          0,
          checkpoint,
        ),
      ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
      const restarted = new UpdateCoordinator(
        root,
        await UpdateStateStore.load(root),
        randomUUID(),
      );
      const recovered = await restarted.reapInterrupted();
      expect(recovered.activeUiId).toBeNull();
      expect(recovered.knownGood).toEqual([]);
      expect(recovered.rejected).toEqual([
        { buildId, code: "UI_TRIAL_INTERRUPTED" },
      ]);
    }));
  it("expired leases and late ready never promote", async () =>
    fixture(async (root, buildId) => {
      const state = await UpdateStateStore.load(root);
      let now = 1000;
      const client = randomUUID(),
        auth = randomUUID(),
        hostId = randomUUID();
      const updates = new UpdateCoordinator(root, state, hostId, () => now);
      updates.register(client, auth);
      const prepared = await updates.prepare(buildId, 0, client, auth);
      const operation = prepared.trial!.operationId;
      const saved = await updates.checkpoint(
        operation,
        client,
        auth,
        0,
        checkpoint,
      );
      await updates.activate(
        operation,
        buildId,
        client,
        auth,
        saved.revision,
        1,
      );
      now += 61_000;
      await expect(
        updates.ready(operation, buildId, client, auth, 1, hostId, 0),
      ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
      updates.register(client, auth);
      await expect(
        updates.ready(operation, buildId, client, auth, 1, hostId, 0),
      ).rejects.toMatchObject({ code: "UI_READY_TIMEOUT" });
      expect(state.snapshot().activeUiId).toBeNull();
    }));
  it("real temporary host reports unknown legacy identities rather than false parity", async () =>
    fixture(async (root) => {
      const host = await startHost({
        root,
        assets: resolve("dist/ui"),
        helper: resolve("dist/native/suri-helper"),
        simulated: true,
      });
      try {
        const receipt = await host.execute(
          {
            v: 1,
            id: randomUUID(),
            type: "updates.get",
            createdAt: new Date().toISOString(),
            payload: {},
          },
          randomUUID(),
        );
        expect(receipt.status).toBe("completed");
        expect(receipt.result?.runningHost.buildId).toBeNull();
        expect(receipt.result?.activationSupported).toBe(false);
        expect(receipt.result?.associationRequired).toBe(true);
        expect(receipt.result?.ui.activeId).toBeNull();
      } finally {
        await host.close();
      }
    }));
});
