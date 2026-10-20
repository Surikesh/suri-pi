import { EventEmitter } from "node:events";
import { Readable, Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

const children: any[] = [];
vi.mock("node:child_process", () => ({
  spawn: () => {
    const child: any = new EventEmitter();
    child.stdout = new Readable({ read() {} });
    child.stderr = new Readable({ read() {} });
    child.requests = [] as any[];
    child.stdin = new Writable({
      write(chunk, _encoding, done) {
        child.requests.push(JSON.parse(chunk.toString()));
        done();
      },
    });
    children.push(child);
    return child;
  },
}));

const { PiClient } = await import("../../packages/pi-adapter/src/index.js");

afterEach(() => {
  children.length = 0;
});

const event = (type: string) => JSON.stringify({ type }) + "\n";
const expected = ["command.result", "session.state:interrupted"];

// A descendant keeps stdout open after the runtime exits: the exit is reported
// after the 1 s grace period, with the decoder finalized first.
async function held(terminator: string, late = false) {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    const order: string[] = [];
    const client = new PiClient(
      { executable: "pi", cwd: ".", sessionDir: "." },
      (type, payload) => {
        if (type === "session.state")
          order.push(`session.state:${payload.phase}`);
        if (type === "run.state") order.push(`run.state:${payload.phase}`);
      },
    );
    const child = children[0];
    const outcome = client.request("prompt", { message: "hi" }).then(
      () => order.push("command.result"),
      (error) => order.push(`rejected:${error.code}`),
    );
    const response = JSON.stringify({
      type: "response",
      id: child.requests[0].id,
      command: "prompt",
      success: true,
      data: {},
    });
    child.stdout.push(Buffer.from(response + terminator));
    child.emit("exit", 0, null);
    await vi.advanceTimersByTimeAsync(999);
    expect(order).not.toContain("session.state:interrupted");
    await vi.advanceTimersByTimeAsync(1);
    await client.exited;
    await outcome;
    if (late) {
      child.stdout.push(Buffer.from(event("agent_start")));
      child.stdout.push(null);
      child.emit("close", 0, null);
      await vi.advanceTimersByTimeAsync(10);
    }
    return order;
  } finally {
    vi.useRealTimers();
  }
}

describe("PiClient exit grace period with stdout held open", () => {
  it("parses an unterminated final response when the grace period expires", async () => {
    expect(await held("")).toEqual(expected);
  });

  it("delivers a terminated response the same way", async () => {
    expect(await held("\n")).toEqual(expected);
  });

  it("ignores data arriving after finalization and reports the exit once", async () => {
    expect(await held("\n", true)).toEqual(expected);
  });
});
