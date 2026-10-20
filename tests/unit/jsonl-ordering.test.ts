import { once } from "node:events";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { JsonlDecoder } from "../../packages/pi-adapter/src/index.js";

const line = (value: object) => JSON.stringify(value) + "\n";
const response = (id: number) => line({ type: "response", id });
const event = line({ type: "event" });

// A response's consumer runs only through promise continuations, like a
// command job awaiting `request()`; it must finish before the next event.
function harness(yieldAfterResponse: boolean) {
  const order: string[] = [];
  const decoder = new JsonlDecoder(
    (r) => {
      if (r.type === "response") {
        order.push(`response:${r.id}`);
        void Promise.resolve()
          .then(() => undefined)
          .then(() => undefined)
          .then(() => order.push(`completed:${r.id}`));
      } else order.push("event");
    },
    () => order.push("fail"),
    undefined,
    yieldAfterResponse,
  );
  return { order, decoder };
}

describe("response ordering barrier", () => {
  it("delivers a response completion before events coalesced in the same chunk", async () => {
    const { order, decoder } = harness(true);
    decoder.feed(Buffer.from(response(1) + event + event));
    await decoder.drained();
    expect(order).toEqual(["response:1", "completed:1", "event", "event"]);
  });

  it("is the barrier, not the timing, that provides the order", async () => {
    const { order, decoder } = harness(false);
    decoder.feed(Buffer.from(response(1) + event));
    await new Promise((resolve) => setImmediate(resolve));
    expect(order).toEqual(["response:1", "event", "completed:1"]);
  });

  it("completes every one of many responses before the event behind them", async () => {
    const { order, decoder } = harness(true);
    const count = 1000;
    let batch = "";
    for (let i = 0; i < count; i++) batch += response(i);
    decoder.feed(Buffer.from(batch + event));
    decoder.end();
    await decoder.drained();
    expect(order).toHaveLength(count * 2 + 1);
    expect(order.at(-1)).toBe("event");
    for (let i = 0; i < count; i++) {
      expect(order[i * 2]).toBe(`response:${i}`);
      expect(order[i * 2 + 1]).toBe(`completed:${i}`);
    }
  });

  it("keeps the barrier at end of input while records are suspended", async () => {
    const { order, decoder } = harness(true);
    decoder.feed(Buffer.from(response(1) + response(2) + event));
    decoder.end();
    expect(decoder.idle).toBe(false);
    expect(order).toEqual(["response:1"]);
    await decoder.drained();
    expect(order).toEqual([
      "response:1",
      "completed:1",
      "response:2",
      "completed:2",
      "event",
    ]);
    expect(decoder.idle).toBe(true);
  });

  it("applies the barrier to an unterminated final record", async () => {
    const { order, decoder } = harness(true);
    decoder.feed(Buffer.from(response(1) + '{"type":"event"}'));
    decoder.end();
    await decoder.drained();
    expect(order).toEqual(["response:1", "completed:1", "event"]);
  });

  it("queues a chunk pushed synchronously behind a response that ended its chunk", async () => {
    const { order, decoder } = harness(true);
    decoder.feed(Buffer.from(response(1)));
    decoder.feed(Buffer.from(event));
    await decoder.drained();
    expect(order).toEqual(["response:1", "completed:1", "event"]);
  });

  it("orders synchronous chunks from a real stream and at EOF", async () => {
    const { order, decoder } = harness(true);
    const stream = new Readable({ read() {} });
    stream.on("data", (chunk: Buffer) => decoder.feed(chunk));
    stream.on("end", () => decoder.end());
    stream.push(Buffer.from(response(1)));
    stream.push(Buffer.from(event));
    stream.push(null);
    await once(stream, "end");
    await decoder.drained();
    expect(order).toEqual(["response:1", "completed:1", "event"]);
  });

  it("queues chunks and EOF that arrive while the barrier is armed", async () => {
    const { order, decoder } = harness(true);
    decoder.feed(Buffer.from(response(1)));
    decoder.feed(Buffer.from(response(2)));
    decoder.feed(Buffer.from(event));
    decoder.end();
    await decoder.drained();
    expect(order).toEqual([
      "response:1",
      "completed:1",
      "response:2",
      "completed:2",
      "event",
    ]);
  });

  it("holds drained() behind a final response without a trailing newline", async () => {
    const { order, decoder } = harness(true);
    decoder.feed(Buffer.from(response(1).trimEnd()));
    decoder.end();
    expect(decoder.idle).toBe(false);
    await decoder.drained();
    expect(order).toEqual(["response:1", "completed:1"]);
  });

  it("is idle and resolves immediately when nothing is suspended", async () => {
    const { order, decoder } = harness(true);
    decoder.feed(Buffer.from(event));
    expect(decoder.idle).toBe(true);
    await decoder.drained();
    expect(order).toEqual(["event"]);
  });
});
