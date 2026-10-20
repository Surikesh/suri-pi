import {
  SuriError,
  type Command,
  type Data,
} from "../../../packages/protocol/src/index.js";
import type { HostQueue } from "./host-queue.js";
import type { HostRuntime } from "./host-runtime.js";
import type { MessageWrites } from "./host-message-writes.js";
import type { Assets } from "./assets.js";
import type { Storage } from "./storage.js";
import type { StartSession } from "./host-types.js";

/**
 * Inert factories for the run and queue async job callbacks. Each method only
 * allocates and returns the async callback (`c`, `p`, `id`, parent data and
 * the draft owner getter are captured by reference and read when the job
 * runs); no validation, store lookup or clone happens here.
 */
export function createRunJobs(caps: {
  store: Storage;
  hostRuntime: Pick<HostRuntime, "client" | "removeSubmission">;
  hostQueue: Pick<HostQueue, "restoreQueue" | "setShadows">;
  assets: Pick<Assets, "prompt">;
  emit: MessageWrites["emit"];
  startSession: StartSession;
}) {
  const { store, hostRuntime, hostQueue, assets, emit, startSession } = caps;
  const { restoreQueue } = hostQueue;
  return {
    runSubmit(
      p: Data,
      id: string,
      message: Awaited<ReturnType<Assets["prompt"]>>,
    ) {
      return async () => {
        try {
          const pi = await startSession(id, undefined, "submit");
          await pi.request(
            p.mode === "prompt"
              ? "prompt"
              : p.mode === "steer"
                ? "steer"
                : "follow_up",
            message,
          );
          return {};
        } finally {
          hostRuntime.removeSubmission(id);
        }
      };
    },
    runCancel(id: string, draftOwner: () => string) {
      return async () => {
        const pi = hostRuntime.client(id);
        if (!pi) throw new SuriError("NOT_FOUND", "No live process.");
        const queue = store.snapshot(`session:${id}`).queue;
        emit(id, "run.state", { phase: "cancelling" });
        await pi.stop();
        return restoreQueue(id, draftOwner(), queue);
      };
    },
    queueClear(id: string, draftOwner: () => string) {
      return async () => {
        const queue = store.snapshot(`session:${id}`).queue;
        await (await startSession(id)).request("clear_queue");
        return restoreQueue(id, draftOwner(), queue);
      };
    },
    queueUpdate(
      c: Command,
      id: string,
      clientId: string,
      update: { mode: string; text: string; queue: Data[]; target: number },
    ) {
      const { mode, text, queue, target } = update;
      return async () => {
        const pi = await startSession(id);
        const rebuilt: Data[] = await Promise.all(
          queue.map(async (item: Data, index: number) => {
            const next = index === target ? { ...item, mode, text } : item;
            const prompt = await assets.prompt(
              next.attachmentIds ?? [],
              id,
              next.text,
            );
            return {
              ...next,
              queueId: `${c.id}:${index}`,
              wireText: prompt.message,
              prompt,
            };
          }),
        );
        await pi.request("clear_queue");
        hostQueue.setShadows(
          id,
          rebuilt.map(({ prompt: _prompt, ...item }) => ({
            ...item,
            clientId,
          })),
        );
        for (const item of rebuilt)
          await pi.request(
            item.mode === "steer" ? "steer" : "follow_up",
            item.prompt,
          );
        return {};
      };
    },
  };
}
