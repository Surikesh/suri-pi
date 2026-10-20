import { z } from "zod";
import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { BuildIdSchema } from "../../../packages/protocol/src/updates.js";
const revision = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const UpdateStateSchema = z.strictObject({
  schema: z.literal(1),
  revision,
  profileId: z.uuid(),
  channel: z.enum(["packaged", "development"]),
  association: z
    .strictObject({
      path: z.string(),
      device: z.string().regex(/^\d+$/),
      inode: z.string().regex(/^\d+$/),
    })
    .nullable(),
  activeUiId: BuildIdSchema.nullable(),
  previousKnownGoodUiId: BuildIdSchema.nullable(),
  packagedFallbackUiId: BuildIdSchema.nullable(),
  knownGood: z.array(BuildIdSchema).max(10_000),
  candidate: z
    .strictObject({ buildId: BuildIdSchema, generation: revision })
    .nullable(),
  rejected: z
    .array(
      z.strictObject({
        buildId: BuildIdSchema.nullable(),
        code: z.enum([
          "CANDIDATE_INTEGRITY",
          "CHECKOUT_CHANGED",
          "CONTRACT_INCOMPATIBLE",
          "NATIVE_REBUILD_REQUIRED",
          "STORAGE_UNAVAILABLE",
          "CANDIDATE_LIMIT",
          "UI_MOUNT_FAILED",
          "UI_READY_TIMEOUT",
          "UI_ASSET_MISSING",
          "UI_TRIAL_INTERRUPTED",
        ]),
      }),
    )
    .max(100),
  pendingHostId: BuildIdSchema.nullable(),
  trial: z
    .strictObject({
      operationId: z.uuid(),
      clientInstanceId: z.uuid(),
      authClientId: z.string(),
      buildId: BuildIdSchema,
      fromId: BuildIdSchema.nullable(),
      phase: z.enum(["prepared", "navigating"]),
      checkpointRevision: revision.nullable(),
      deadline: revision,
    })
    .nullable(),
});
type UpdateState = z.infer<typeof UpdateStateSchema>;
class UpdateStateFailure extends Error {
  constructor(
    readonly code:
      "UPDATE_STATE_CORRUPT" | "STORAGE_UNAVAILABLE" | "UPDATE_CONFLICT",
  ) {
    super(code);
  }
}
export async function writeUpdateFile(path: string, bytes: string) {
  const temp = path + ".tmp-" + randomUUID();
  let fd;
  try {
    fd = await open(temp, "wx", 0o600);
    await fd.writeFile(bytes);
    await fd.sync();
    await fd.close();
    fd = undefined;
    await rename(temp, path);
    const parent = await open(dirname(path), "r");
    try {
      await parent.sync();
    } finally {
      await parent.close();
    }
  } finally {
    await fd?.close();
    await rm(temp, { force: true });
  }
}
export class UpdateStateStore {
  private queue: Promise<unknown> = Promise.resolve();
  private failed = false;
  private constructor(
    readonly directory: string,
    private current: UpdateState,
  ) {}
  static async load(root: string) {
    const directory = join(root, "updates");
    try {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      let raw: string;
      try {
        raw = await readFile(join(directory, "state.json"), "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        // Missing primary with a backup means an interrupted/corrupt state, not a new profile.
        try {
          await readFile(join(directory, "state.previous.json"));
          throw new UpdateStateFailure("UPDATE_STATE_CORRUPT");
        } catch (backupError) {
          if ((backupError as NodeJS.ErrnoException).code !== "ENOENT")
            throw backupError;
        }
        const initial: UpdateState = {
          schema: 1,
          revision: 0,
          profileId: randomUUID(),
          channel: "packaged",
          association: null,
          activeUiId: null,
          previousKnownGoodUiId: null,
          packagedFallbackUiId: null,
          knownGood: [],
          candidate: null,
          rejected: [],
          pendingHostId: null,
          trial: null,
        };
        await writeUpdateFile(
          join(directory, "state.json"),
          JSON.stringify(initial),
        );
        return new UpdateStateStore(directory, initial);
      }
      let current: UpdateState;
      try {
        current = UpdateStateSchema.parse(JSON.parse(raw));
      } catch {
        throw new UpdateStateFailure("UPDATE_STATE_CORRUPT");
      }
      return new UpdateStateStore(directory, current);
    } catch (error) {
      if (error instanceof UpdateStateFailure) throw error;
      throw new UpdateStateFailure("STORAGE_UNAVAILABLE");
    }
  }
  snapshot(): UpdateState {
    return structuredClone(this.current);
  }
  change(
    expected: number,
    mutate: (state: UpdateState) => void,
  ): Promise<UpdateState> {
    const operation = this.queue.then(async () => {
      if (this.failed) throw new UpdateStateFailure("STORAGE_UNAVAILABLE");
      if (
        expected !== this.current.revision ||
        expected >= Number.MAX_SAFE_INTEGER
      )
        throw new UpdateStateFailure("UPDATE_CONFLICT");
      const next = this.snapshot();
      mutate(next);
      next.revision++;
      UpdateStateSchema.parse(next);
      try {
        await writeUpdateFile(
          join(this.directory, "state.previous.json"),
          JSON.stringify(this.current),
        );
        await writeUpdateFile(
          join(this.directory, "state.json"),
          JSON.stringify(next),
        );
      } catch {
        // The rename may have succeeded before fsync failed: disable mutations
        // rather than retry against a potentially stale in-memory revision.
        this.failed = true;
        throw new UpdateStateFailure("STORAGE_UNAVAILABLE");
      }
      this.current = next;
      return this.snapshot();
    });
    // The queue only orders operations; each caller receives its own failure via operation, so the chain continues after one.
    this.queue = operation.catch(() => {});
    return operation;
  }
}
