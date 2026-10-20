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

// The command completion is consumed through promise continuations, exactly
// like a host job awaiting request(); it must precede the terminal state.
async function run(script: (child: any, response: string) => void) {
  const order: string[] = [];
  const client = new PiClient(
    { executable: "pi", cwd: ".", sessionDir: "." },
    (type, payload) => {
      if (type === "session.state")
        order.push(`session.state:${payload.phase}`);
    },
  );
  const child = children[0];
  const done = client
    .request("prompt", { message: "hi" })
    .then(() => undefined)
    .then(() => undefined)
    .then(() => order.push("command.result"));
  await vi.waitFor(() => expect(child.requests).toHaveLength(1));
  const response = JSON.stringify({
    type: "response",
    id: child.requests[0].id,
    command: "prompt",
    success: true,
    data: {},
  });
  script(child, response);
  await client.exited;
  await done;
  return order;
}

const event = (type: string) => JSON.stringify({ type }) + "\n";
const expected = ["command.result", "session.state:interrupted"];

describe("PiClient orders a command result before the terminal state", () => {
  it("for a final response without a trailing newline", async () => {
    const order = await run((child, response) => {
      child.stdout.push(Buffer.from(response));
      child.stdout.push(null);
      child.emit("exit", 0, null);
      // close follows the end of the stdio streams, as with a real child
      child.stdout.once("end", () => child.emit("close", 0, null));
    });
    expect(order).toEqual(expected);
  });

  it("for a response ending its chunk, followed by exit before stdout ends", async () => {
    const order = await run((child, response) => {
      child.stdout.push(Buffer.from(response + "\n"));
      child.emit("exit", 0, null);
      child.stdout.push(null);
      // close follows the end of the stdio streams, as with a real child
      child.stdout.once("end", () => child.emit("close", 0, null));
    });
    expect(order).toEqual(expected);
  });

  it("for a response followed by events and exit", async () => {
    const order = await run((child, response) => {
      child.stdout.push(
        Buffer.from(
          response + "\n" + event("agent_start") + event("agent_end"),
        ),
      );
      child.stdout.push(null);
      child.emit("exit", 0, null);
      // close follows the end of the stdio streams, as with a real child
      child.stdout.once("end", () => child.emit("close", 0, null));
    });
    expect(order).toEqual(expected);
  });
});
