import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { UpdateCheckpoints } from "../../apps/host/src/update-checkpoint.js";
import type { UpdateCheckpoint } from "../../packages/protocol/src/update-checkpoint.js";
const checkpoint: UpdateCheckpoint = {
  schema: 1,
  selectedProjectId: null,
  selectedWorkspaceId: null,
  selectedSessionId: null,
  draft: {
    text: "unsent fixture",
    attachmentIds: [randomUUID()],
    revision: 3,
    outboxIds: [],
  },
  expandedIds: ["tool:fixture"],
  anchor: {
    messageId: "message:fixture",
    blockId: null,
    offset: 15,
    bottomFollow: false,
  },
  layout: { sidebarOpen: true, detailsOpen: false, focus: "composer" },
};
describe("update checkpoints", () => {
  it("persists full per-window state with revision and authenticated ownership", async () => {
    const root = await mkdtemp(join(tmpdir(), "suri-checkpoint-"));
    try {
      const store = new UpdateCheckpoints(root);
      const client = randomUUID(),
        auth = randomUUID(),
        operation = randomUUID();
      const record = await store.save(client, auth, operation, 0, checkpoint);
      expect(record.revision).toBe(1);
      expect(
        (await new UpdateCheckpoints(root).read(client, auth))?.checkpoint,
      ).toEqual(checkpoint);
      await expect(store.read(client, randomUUID())).rejects.toMatchObject({
        code: "UNAUTHORIZED",
      });
      await expect(
        store.save(client, auth, operation, 0, checkpoint),
      ).rejects.toMatchObject({ code: "CHECKPOINT_CONFLICT" });
      const duplicates = await Promise.allSettled([
        store.save(client, auth, operation, 1, checkpoint),
        store.save(client, auth, operation, 1, checkpoint),
      ]);
      expect(duplicates.map((result) => result.status)).toEqual([
        "fulfilled",
        "rejected",
      ]);
      expect(await store.read(randomUUID(), auth)).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
