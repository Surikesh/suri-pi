import { randomUUID } from "node:crypto";
import { describe, expect, test, vi } from "vitest";
import {
  SuriError,
  type Command,
  type Receipt,
} from "../../packages/protocol/src/index.js";
import { AsyncJobOwner } from "../../apps/host/src/async-jobs.js";

function command(id = randomUUID()): Command {
  return {
    v: 1,
    id,
    createdAt: new Date().toISOString(),
    type: "fixture.async",
    payload: {},
    sessionId: randomUUID(),
  };
}

function fixture(
  persist?: (receipt: Receipt) => Receipt,
  publish?: (stream: string) => void,
) {
  const order: string[] = [];
  const receipts: Receipt[] = [];
  const marks: string[] = [];
  const owner = new AsyncJobOwner({
    markAsync: (id, stream) => {
      marks.push(`${id}@${stream}`);
    },
    persistReceipt: (receipt) => {
      order.push(`persist:${receipt.status}`);
      const saved = persist ? persist(receipt) : receipt;
      receipts.push(saved);
      return saved;
    },
    publish: (stream, type, payload) => {
      publish?.(stream);
      order.push(`publish:${type}:${(payload as Receipt).status}`);
    },
  });
  return { owner, order, receipts, marks };
}

describe("async command job ownership", () => {
  test("persists a terminal receipt before publishing and drains scheduled work", async () => {
    const { owner, order } = fixture();
    expect(owner.submit(command(), async () => ({ value: 1 })).status).toBe(
      "accepted",
    );
    await owner.drain();
    expect(order).toEqual([
      "persist:completed",
      "publish:command.result:completed",
    ]);
    expect(owner.pendingCount).toBe(0);
  });

  test("accepted work not yet entered still receives a terminal receipt during drain", async () => {
    const job = vi.fn(async () => ({ completed: true }));
    const { owner, receipts } = fixture();
    owner.submit(command(), job);
    await owner.drain();
    expect(job).toHaveBeenCalledOnce();
    expect(receipts).toMatchObject([{ status: "completed" }]);
  });

  test("drains an already-running job and persists rejection before publication", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { owner, order, receipts } = fixture();
    owner.submit(command(), async () => {
      await gate;
      throw new SuriError("FIXTURE_REJECTED", "Safe fixture rejection.");
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(owner.pendingCount).toBe(1);
    release();
    await owner.drain();
    expect(receipts[0]).toMatchObject({
      status: "rejected",
      error: { code: "FIXTURE_REJECTED" },
    });
    expect(order[0]).toBe("persist:rejected");
    expect(order[1]).toBe("publish:command.result:rejected");
  });

  test("converts a transient terminal persist failure to a durable bounded rejection", async () => {
    let calls = 0;
    const diagnostics: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...values) => {
      diagnostics.push(values.join(" "));
    });
    const sentinel = "synthetic-secret-must-not-escape";
    const { owner, receipts, order } = fixture((receipt) => {
      if (calls++ === 0)
        throw new Error(sentinel, { cause: { token: sentinel } });
      return receipt;
    });
    owner.submit(command(), async () => ({ value: 1 }));
    await owner.drain();
    expect(receipts[0]).toMatchObject({
      status: "rejected",
      error: { code: "ASYNC_COMPLETION_PERSIST_FAILED" },
    });
    expect(order.at(-1)).toBe("publish:command.result:rejected");
    expect(JSON.stringify(diagnostics)).not.toContain(sentinel);
    vi.restoreAllMocks();
  });

  test("fails shutdown drain when no terminal receipt can be persisted", async () => {
    const { owner } = fixture(() => {
      throw new Error("persistent storage failure");
    });
    owner.submit(command(), async () => ({}));
    await expect(owner.drain()).rejects.toMatchObject({
      code: "ASYNC_DRAIN_FAILED",
    });
  });

  test("marks the accepted receipt with its stream before any work is scheduled", async () => {
    const job = vi.fn(async () => ({}));
    const { owner, marks } = fixture();
    const c = command();
    owner.submit(c, job);
    expect(marks).toEqual([`${c.id}@session:${c.sessionId}`]);
    expect(job).not.toHaveBeenCalled();
    const catalog = { ...command(), sessionId: undefined };
    owner.submit(catalog, job);
    expect(marks[1]).toBe(`${catalog.id}@catalog`);
    await owner.drain();
  });

  test("a failed routing marker refuses the command and never schedules the job", async () => {
    const job = vi.fn(async () => ({}));
    const owner = new AsyncJobOwner({
      markAsync: () => {
        throw new Error("synthetic marker failure");
      },
      persistReceipt: (receipt) => receipt,
      publish: () => undefined,
    });
    expect(() => owner.submit(command(), job)).toThrow("synthetic marker");
    expect(owner.pendingCount).toBe(0);
    await owner.drain();
    expect(job).not.toHaveBeenCalled();
  });

  test("unresolved completion blockers survive repeated drain failures and clear after persistence", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    let failing = true;
    const attempts: string[] = [];
    const { owner, receipts, order } = fixture((receipt) => {
      attempts.push(
        receipt.status + (receipt.error ? `:${receipt.error.code}` : ""),
      );
      if (failing) throw new Error("synthetic storage failure");
      return receipt;
    });
    const job = vi.fn(async () => ({ value: "never-published" }));
    owner.submit(command(), job);
    await expect(owner.drain()).rejects.toMatchObject({
      code: "ASYNC_DRAIN_FAILED",
    });
    // The job ran once; it is no longer pending but its completion is owed.
    expect(owner.pendingCount).toBe(0);
    expect(owner.unresolvedCount).toBe(1);
    expect(attempts).toEqual([
      "completed",
      "rejected:ASYNC_COMPLETION_PERSIST_FAILED",
    ]);
    // Later drains retry only the terminal rejection; the blocker stays.
    for (const round of [1, 2]) {
      await expect(owner.drain()).rejects.toMatchObject({
        code: "ASYNC_DRAIN_FAILED",
      });
      expect(owner.unresolvedCount).toBe(1);
      expect(attempts).toHaveLength(2 + round);
    }
    expect(order.filter((e) => e.startsWith("publish"))).toEqual([]);
    failing = false;
    await owner.drain();
    expect(owner.unresolvedCount).toBe(0);
    expect(job).toHaveBeenCalledOnce();
    expect(receipts).toMatchObject([
      {
        status: "rejected",
        error: { code: "ASYNC_COMPLETION_PERSIST_FAILED" },
      },
    ]);
    expect(order.slice(-2)).toEqual([
      "persist:rejected",
      "publish:command.result:rejected",
    ]);
    await owner.drain();
    expect(order.filter((e) => e.startsWith("publish"))).toHaveLength(1);
    vi.restoreAllMocks();
  });

  test("a retry whose result event fails keeps the blocker and does not rewrite the saved receipt", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    let persistFails = 2;
    let publishFails = 1;
    const { owner, order } = fixture(
      (receipt) => {
        if (persistFails-- > 0) throw new Error("synthetic");
        return receipt;
      },
      () => {
        if (publishFails-- > 0) throw new Error("synthetic event failure");
      },
    );
    owner.submit(command(), async () => ({}));
    await expect(owner.drain()).rejects.toMatchObject({
      code: "ASYNC_DRAIN_FAILED",
    });
    await expect(owner.drain()).rejects.toMatchObject({
      code: "ASYNC_DRAIN_FAILED",
    });
    expect(owner.unresolvedCount).toBe(1);
    expect(order.filter((e) => e === "persist:rejected")).toHaveLength(2);
    await owner.drain();
    expect(owner.unresolvedCount).toBe(0);
    // Persisted once on the retry; the event retry did not rewrite it.
    expect(order.filter((e) => e === "persist:rejected")).toHaveLength(2);
    expect(order.at(-1)).toBe("publish:command.result:rejected");
    vi.restoreAllMocks();
  });
});
