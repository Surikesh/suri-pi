import {
  SuriError,
  failure,
  type Command,
  type Data,
  type Receipt,
} from "../../../packages/protocol/src/index.js";
import { reportDiagnostic } from "./safe-diagnostics.js";

type AsyncJobCapabilities = {
  persistReceipt: (receipt: Receipt) => Receipt;
  publish: (streamId: string, type: string, payload: Data) => unknown;
  /** Durably marks the accepted receipt with its completion stream. */
  markAsync: (id: string, streamId: string) => void;
};

/** A terminal rejection whose durable write or result event is still owed. */
type Unresolved = {
  stream: string;
  receipt: Receipt;
  saved?: Receipt;
  reported: boolean;
};

export class AsyncJobOwner {
  readonly #pending = new Set<Promise<void>>();
  readonly #unresolved = new Map<string, Unresolved>();

  constructor(private readonly capabilities: AsyncJobCapabilities) {}

  get pendingCount() {
    return this.#pending.size;
  }

  /** Completions whose terminal rejection is not yet durable and published. */
  get unresolvedCount() {
    return this.#unresolved.size;
  }

  submit(command: Command, job: () => Promise<Data>): Receipt {
    // Once accepted, this task is owned even if shutdown begins before the
    // scheduled callback enters. Admission is closed by the dispatch owner;
    // accepted work is completed or receives a durable terminal rejection.
    this.capabilities.markAsync(command.id, streamOf(command));
    const pending = new Promise<void>((resolve) => {
      setImmediate(() => {
        void this.#run(command, job).finally(resolve);
      });
    }).finally(() => this.#pending.delete(pending));
    this.#pending.add(pending);
    return { v: 1, id: command.id, status: "accepted" };
  }

  async #run(command: Command, job: () => Promise<Data>) {
    let terminal: Receipt;
    try {
      terminal = {
        v: 1,
        id: command.id,
        status: "completed",
        result: await job(),
      };
    } catch (error) {
      if (!(error instanceof SuriError))
        reportDiagnostic("async-job", "ASYNC_JOB_FAILED");
      terminal = failure(command.id, error);
    }

    let persisted: Receipt;
    try {
      persisted = this.capabilities.persistReceipt(terminal);
    } catch {
      reportDiagnostic("async-job", "ASYNC_RECEIPT_PERSIST_FAILED");
      const fallback = failure(
        command.id,
        new SuriError(
          "ASYNC_COMPLETION_PERSIST_FAILED",
          "The accepted operation could not persist its completion.",
          true,
        ),
      );
      try {
        persisted = this.capabilities.persistReceipt(fallback);
      } catch {
        this.#unresolved.set(command.id, {
          stream: streamOf(command),
          receipt: fallback,
          reported: false,
        });
        return;
      }
    }
    this.capabilities.publish(streamOf(command), "command.result", persisted);
  }

  /** The first drain reports a failure; later drains retry only its terminal persistence and result event, never the job. */
  #settle() {
    for (const [id, item] of this.#unresolved) {
      if (!item.reported) {
        item.reported = true;
        continue;
      }
      try {
        item.saved ??= this.capabilities.persistReceipt(item.receipt);
        this.capabilities.publish(item.stream, "command.result", item.saved);
        this.#unresolved.delete(id);
      } catch {
        reportDiagnostic("async-job", "ASYNC_RECEIPT_PERSIST_FAILED");
      }
    }
  }

  async drain(): Promise<void> {
    while (this.#pending.size) await Promise.allSettled([...this.#pending]);
    this.#settle();
    if (this.#unresolved.size)
      throw new SuriError(
        "ASYNC_DRAIN_FAILED",
        "Accepted command completion could not be persisted.",
        true,
      );
  }
}

const streamOf = (command: Command) =>
  command.sessionId ? `session:${command.sessionId}` : "catalog";
