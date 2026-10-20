import { it, expect } from "vitest";
import { createMessageWrites } from "../../apps/host/src/host-message-writes.js";
import type { Assets } from "../../apps/host/src/assets.js";
import type { Interactions } from "../../apps/host/src/host-interactions.js";

const writes = () =>
  createMessageWrites({
    assets: {} as Assets,
    closing: () => false,
    hostRuntime: { touch: () => {}, client: () => undefined },
    hostQueue: { shadows: () => undefined },
    publish: () => {
      throw new Error("no publish expected");
    },
    interactions: {} as Interactions,
  });

it("an empty shutdown drain settles without yielding a microtask", async () => {
  const owner = writes();
  expect(owner.nextDrain()).toBeUndefined();
  // Mirrors the host shutdown tail: with nothing pending, storage close runs
  // before control returns, exactly like the pre-F7b empty while loop.
  const order: string[] = [];
  const tail = (async () => {
    let batch;
    while ((batch = owner.nextDrain())) await batch;
    order.push("storage");
  })();
  order.push("caller");
  await tail;
  expect(order).toEqual(["storage", "caller"]);
});

/** Owner whose artifact upload is held, with an observable closing flag. */
function held() {
  const state = { closing: false };
  const published: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const owner = createMessageWrites({
    assets: {
      upload: async () => {
        await gate;
        return { id: "asset" };
      },
      head: () => 0,
      discard: () => {},
    } as unknown as Assets,
    closing: () => state.closing,
    hostRuntime: { touch: () => {}, client: () => undefined },
    hostQueue: { shadows: () => undefined },
    publish: (stream: string, type: string, p: any) => {
      if (stream.startsWith("session:"))
        published.push(p.messageId ? `${type}:${p.messageId}` : type);
      return { seq: published.length } as never;
    },
    interactions: {} as Interactions,
  });
  const image = { id: "i", data: "AA==", mime: "image/png" };
  const message = (messageId: string, final = true) => ({
    messageId,
    role: "assistant",
    final,
    blocks: [],
  });
  return { state, published, release, owner, image, message };
}

it("close drains owned image, continuation and buffered writes in order, rejecting late emissions", async () => {
  const { state, published, release, owner, image, message } = held();
  owner.emit("s", "artifact.inline", image);
  owner.emit("s", "message.upsert", message("after"));
  owner.emit("s", "message.upsert", message("buffered", false));
  state.closing = true;
  // Admission is captured at emit entry: these never reach the store.
  owner.emit("s", "message.upsert", message("late"));
  owner.emit("s", "artifact.inline", image);
  owner.emit("s", "notice", { code: "LATE" });
  expect(owner.imageWriteCount()).toBe(1);
  owner.flushAll();
  expect(published).toEqual(["message.upsert:buffered"]);

  const batch = owner.nextDrain();
  expect(batch).toBeInstanceOf(Promise);
  release();
  let next;
  let drained = 0;
  for (next = batch; next; next = owner.nextDrain()) {
    await next;
    drained++;
  }
  expect(published).toEqual([
    "message.upsert:buffered",
    "artifact.ready",
    "message.upsert:after",
  ]);
  expect(drained).toBe(1);
  expect(owner.nextDrain()).toBeUndefined();
  expect(owner.pendingMessageCount()).toBe(0);
});

it("a continuation queued behind a finished image job is still awaited by the drain", async () => {
  const { state, published, release, owner, image, message } = held();
  owner.emit("s", "artifact.inline", image);
  owner.emit("s", "message.upsert", message("after"));
  state.closing = true;
  const batch = owner.nextDrain()!;
  release();
  await batch;
  expect(published).toEqual(["artifact.ready", "message.upsert:after"]);
  expect(owner.nextDrain()).toBeUndefined();
});
