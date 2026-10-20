import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
  CheckpointRecordSchema,
  type CheckpointRecord,
  type UpdateCheckpoint,
} from "../../../packages/protocol/src/update-checkpoint.js";
import { writeUpdateFile } from "./update-state.js";
class CheckpointFailure extends Error {
  constructor(
    readonly code:
      "CHECKPOINT_CONFLICT" | "CLIENT_STATE_UNSAVED" | "UNAUTHORIZED",
  ) {
    super(code);
  }
}
export class UpdateCheckpoints {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(readonly root: string) {}
  private path(client: string) {
    return join(
      this.root,
      "updates/checkpoints",
      z.uuid().parse(client) + ".json",
    );
  }
  async read(client: string, auth: string): Promise<CheckpointRecord | null> {
    let raw: string;
    try {
      raw = await readFile(this.path(client), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw new CheckpointFailure("CLIENT_STATE_UNSAVED");
    }
    try {
      if (Buffer.byteLength(raw) > 8 * 1024 * 1024) throw Error();
      const record = CheckpointRecordSchema.parse(JSON.parse(raw));
      if (record.authClientId !== auth || record.clientInstanceId !== client)
        throw new CheckpointFailure("UNAUTHORIZED");
      return record;
    } catch (error) {
      if (error instanceof CheckpointFailure) throw error;
      throw new CheckpointFailure("CLIENT_STATE_UNSAVED");
    }
  }
  save(
    client: string,
    auth: string,
    operationId: string,
    expected: number,
    checkpoint: UpdateCheckpoint,
  ): Promise<CheckpointRecord> {
    const result = this.queue.then(async () => {
      const previous = await this.read(client, auth);
      if ((previous?.revision ?? 0) !== expected)
        throw new CheckpointFailure("CHECKPOINT_CONFLICT");
      const record = CheckpointRecordSchema.parse({
        clientInstanceId: client,
        authClientId: auth,
        operationId,
        revision: expected + 1,
        checkpoint,
      });
      const bytes = JSON.stringify(record);
      if (Buffer.byteLength(bytes) > 8 * 1024 * 1024)
        throw new CheckpointFailure("CLIENT_STATE_UNSAVED");
      try {
        await mkdir(join(this.root, "updates/checkpoints"), {
          recursive: true,
          mode: 0o700,
        });
        await writeUpdateFile(this.path(client), bytes);
      } catch {
        throw new CheckpointFailure("CLIENT_STATE_UNSAVED");
      }
      return record;
    });
    // The queue only orders writes; each caller receives its own failure via result, so the chain continues after one.
    this.queue = result.catch(() => {});
    return result;
  }
}
