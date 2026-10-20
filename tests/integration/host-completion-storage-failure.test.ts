import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import {
  chmod,
  mkdir,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import WebSocket from "ws";
import { browserHost } from "../support/browser-host.js";
import { control } from "../../apps/host/src/cli.js";
import { Assets } from "../../apps/host/src/assets.js";
import { Storage } from "../../apps/host/src/storage.js";

// Pre-move characterization of host completion publication when storage fails
// (apps/host/src/host.ts publish / emit / emitImmediate, AsyncJobOwner wiring
// and close). Uses host.execute directly (fixture.execute discards accepted
// receipts), held session.resume / run.submit completions (gated fixture Pi),
// one subscribed real WebSocket, and spies on host.store.receipt / .event.
// AsyncJobOwner captures the host `publish` closure, so host.publish cannot be
// spied; the publish spy is host.store.event (publish's first step). Where HEAD
// looks odd the test asserts what it actually does ("characterized HEAD").

type Fixture = Awaited<ReturnType<typeof browserHost>>;
type Row = Record<string, any>;

let fixture: Fixture;
let gates: string;
let sessionId: string;
let sockets: WebSocket[] = [];
let skipFixtureClose = false;

const FUTURE = () => Date.now() + 16 * 60_000;
const gateFile = (name: string) => join(gates, `hold-${name}`);
const hold = (name: string) => writeFile(gateFile(name), "");
const release = (name: string) => rm(gateFile(name), { force: true });
const jsonl = async (name: string): Promise<Row[]> => {
  try {
    return (await readFile(join(gates, name), "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
};
const calls = (type: string) =>
  jsonl("calls.jsonl").then((rows) => rows.filter((r) => r.type === type));
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((a) => (resolve = a));
  return { promise, resolve };
}
const turns = async (count = 20) => {
  for (let i = 0; i < count; i++) await new Promise((r) => setImmediate(r));
};

/** Patched copy of the fixture Pi: gated responses, call log (no exit gate). */
async function installGatedPi(root: string) {
  const source = await readFile("tests/fixtures/fake-pi.mjs", "utf8");
  const emitDefinition = `const emit = (value) => process.stdout.write(JSON.stringify(value) + "\\n");`;
  const callLine = `const c = JSON.parse(line);`;
  expect(source).toContain(emitDefinition);
  expect(source).toContain(callLine);
  const patched = source
    .replace(
      emitDefinition,
      `import { existsSync as __exists, appendFileSync as __append } from "node:fs";
const __G = ${JSON.stringify(gates)};
const __out = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
const __queue = [];
let __timer;
const __gated = (value) => value.type === "response" && __exists(join(__G, "hold-" + value.command));
const __flush = () => {
  while (__queue.length && !__gated(__queue[0])) __out(__queue.shift());
  if (!__queue.length) { clearInterval(__timer); __timer = undefined; }
};
const emit = (value) => {
  if (__queue.length || __gated(value)) {
    __queue.push(value);
    __timer ??= setInterval(__flush, 2);
    return;
  }
  __out(value);
};`,
    )
    .replace(
      callLine,
      `${callLine}
  __append(join(__G, "calls.jsonl"), JSON.stringify({ pid: process.pid, type: c.type, message: c.message }) + "\\n");`,
    );
  const executable = join(root, "fake-pi", "dist", "cli.mjs");
  await writeFile(executable, patched, { mode: 0o755 });
  await chmod(executable, 0o755);
}

const sessionStream = () => `session:${sessionId}`;
const phase = () => fixture.host.store.snapshot(sessionStream()).phase;
const head = () => fixture.host.store.head(sessionStream());
async function blockerKinds(): Promise<string[]> {
  const health = await control(fixture.data, { type: "health" });
  return health.work.blockers.map((blocker: Row) => blocker.kind);
}
async function categories(): Promise<string[]> {
  const health = await control(fixture.data, { type: "health" });
  return (
    health.work.blockers
      .find((blocker: Row) => blocker.kind === "sessions-or-rpc")
      ?.owners?.find((item: Row) => item.owner === sessionId)?.categories ?? []
  );
}
async function warm() {
  await fixture.execute("session.resume", {}, sessionId);
  await expect.poll(() => fixture.host.children.has(sessionId)).toBe(true);
  await expect.poll(() => phase()).toBe("idle");
  await expect
    .poll(async () => (await blockerKinds()).includes("accepted-jobs"))
    .toBe(false);
}
const pidOf = () => fixture.host.children.get(sessionId)!.child.pid!;

async function probeLock() {
  const child = spawn(
    resolve("dist/native/suri-helper"),
    ["lock", join(fixture.data, "run", "host.lock")],
    { stdio: ["pipe", "pipe", "ignore"] },
  );
  const result = await new Promise<"locked" | "busy">((done) => {
    child.stdout.once("data", () => done("locked"));
    child.once("exit", () => done("busy"));
  });
  if (result === "locked") {
    child.stdin.end();
    await new Promise((done) => child.once("exit", done));
  }
  return result;
}

/** Real authenticated WebSocket subscribed to the session stream. */
async function subscribe() {
  const { nonce } = await control(fixture.data, { type: "bootstrap" });
  const origin = fixture.host.origin;
  const login = await fetch(origin + "/v1/bootstrap", {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify({ nonce }),
  });
  expect(login.status).toBe(200);
  const cookie = login.headers.get("set-cookie")!.split(";")[0];
  const socket = new WebSocket(origin.replace("http", "ws") + "/v1/events", {
    headers: { Cookie: cookie, Origin: origin },
  });
  sockets.push(socket);
  const frames: Row[] = [];
  const waiters: { p: (f: Row) => boolean; resolve: (f: Row) => void }[] = [];
  socket.on("message", (bytes) => {
    const frame = JSON.parse(bytes.toString());
    frames.push(frame);
    for (const w of [...waiters])
      if (w.p(frame)) {
        waiters.splice(waiters.indexOf(w), 1);
        w.resolve(frame);
      }
  });
  socket.on("error", () => {});
  await new Promise<void>((done) => socket.once("open", () => done()));
  const next = (p: (f: Row) => boolean) =>
    new Promise<Row>((done) => {
      const seen = frames.find(p);
      if (seen) done(seen);
      else waiters.push({ p, resolve: done });
    });
  socket.send(
    JSON.stringify({ v: 1, type: "subscribe", streamId: sessionStream() }),
  );
  await next((f) => f.type === "snapshot");
  return { socket, frames, next };
}
type Sub = Awaited<ReturnType<typeof subscribe>>;
const resultFrames = (sub: Sub, id: string) =>
  sub.frames.filter((f) => f.type === "command.result" && f.payload?.id === id);

const envelope = (type: string, payload: Row = {}) => ({
  v: 1 as const,
  id: randomUUID(),
  createdAt: new Date().toISOString(),
  type,
  payload,
  sessionId,
});

/** Accept an async command via host.execute and park its completion. */
async function acceptHeld(kind: "session.resume" | "run.submit") {
  let command;
  if (kind === "session.resume") {
    await hold("get_state");
    command = envelope("session.resume");
  } else {
    await warm();
    await hold("prompt");
    command = envelope("run.submit", {
      text: "held prompt",
      mode: "prompt",
      attachmentIds: [],
    });
  }
  const receipt = await fixture.host.execute(command, "fixture-client");
  expect(receipt).toEqual({ v: 1, id: command.id, status: "accepted" });
  await expect
    .poll(
      async () =>
        (await calls(kind === "run.submit" ? "prompt" : "get_state")).length,
    )
    .toBe(1);
  return {
    command,
    id: command.id,
    free: () => release(kind === "run.submit" ? "prompt" : "get_state"),
  };
}

/** Fail the first `failures` terminal writes of one command id. */
let receiptSpy: ReturnType<typeof vi.spyOn> | undefined;
function failTerminalReceipts(id: string, failures: number) {
  const writes: string[] = [];
  const original = fixture.host.store.receipt.bind(fixture.host.store);
  receiptSpy = vi
    .spyOn(fixture.host.store, "receipt")
    .mockImplementation((r: any) => {
      if (r.id === id && r.status !== "accepted") {
        writes.push(r.status + (r.error ? `:${r.error.code}` : ""));
        if (writes.length <= failures)
          throw new Error("synthetic storage failure");
      }
      return original(r);
    });
  return writes;
}
/** Record every store.event write (publish's first step) per stream. */
function recordEvents() {
  const seen: Row[] = [];
  const original = fixture.host.store.event.bind(fixture.host.store);
  vi.spyOn(fixture.host.store, "event").mockImplementation(
    (stream: string, type: string, payload: any) => {
      const event = original(stream, type, payload);
      seen.push({ stream, type, payload, seq: event.seq });
      return event;
    },
  );
  return seen;
}

beforeEach(async () => {
  skipFixtureClose = false;
  receiptSpy = undefined;
  vi.spyOn(console, "error").mockImplementation(() => {});
  fixture = await browserHost();
  gates = join(fixture.root, "gates");
  await mkdir(gates);
  await installGatedPi(fixture.root);
  sessionId = fixture.session.id;
});
afterEach(async () => {
  for (const socket of sockets) socket.terminate();
  sockets = [];
  await Promise.all(["get_state", "prompt"].map((name) => release(name)));
  vi.restoreAllMocks();
  if (skipFixtureClose)
    await rm(fixture.root, { recursive: true, force: true });
  else await fixture.close();
});

it.each(["session.resume", "run.submit"] as const)(
  "%s: a failed first terminal receipt write yields only the durable ASYNC_COMPLETION_PERSIST_FAILED rejection",
  async (kind) => {
    const sub = await subscribe();
    const { command, id, free } = await acceptHeld(kind);
    const writes = failTerminalReceipts(id, 1);
    const events = recordEvents();
    expect(fixture.host.store.commandReceipt(id)?.status).toBe("accepted");

    await free();
    const frame = await sub.next(
      (f) => f.type === "command.result" && f.payload?.id === id,
    );
    await turns();

    // First terminal write (completed) threw; the retry persisted a bounded
    // rejection, and only that rejection was published.
    expect(writes).toEqual([
      "completed",
      "rejected:ASYNC_COMPLETION_PERSIST_FAILED",
    ]);
    expect(frame.payload).toMatchObject({
      v: 1,
      id,
      status: "rejected",
      error: { code: "ASYNC_COMPLETION_PERSIST_FAILED", retryable: true },
    });
    expect(JSON.stringify(frame)).not.toContain("synthetic storage failure");
    expect(resultFrames(sub, id)).toHaveLength(1);
    expect(
      sub.frames.some(
        (f) => f.payload?.id === id && f.payload?.status === "completed",
      ),
    ).toBe(false);

    const durable = fixture.host.store.commandReceipt(id)!;
    expect(durable).toEqual(frame.payload);
    const replayed = fixture.host.store
      .replay(sessionStream(), 0)
      .filter((e: Row) => e.type === "command.result" && e.payload.id === id);
    expect(replayed.map((e: Row) => e.payload)).toEqual([durable]);
    expect(
      events.filter((e) => e.type === "command.result" && e.payload.id === id),
    ).toHaveLength(1);

    // Re-submitting the same command id replays the durable rejection.
    const again = await fixture.host.execute(command, "fixture-client");
    expect(again).toEqual(durable);
  },
);

it.each(["session.resume", "run.submit"] as const)(
  "%s: failing both terminal receipt writes publishes no terminal frame and fails close with ASYNC_DRAIN_FAILED before storage close and lock release",
  async (kind) => {
    skipFixtureClose = true;
    const sub = await subscribe();
    const { id, free } = await acceptHeld(kind);
    const writes = failTerminalReceipts(id, Infinity);
    const events = recordEvents();
    const order: string[] = [];
    const storeClose = fixture.host.store.close.bind(fixture.host.store);
    vi.spyOn(fixture.host.store, "close").mockImplementation(() => {
      order.push("store.close");
      storeClose();
    });
    const host = fixture.host;

    await free();
    await expect.poll(() => writes.length).toBe(2);
    await expect
      .poll(async () => (await blockerKinds()).includes("accepted-jobs"))
      .toBe(false);
    await turns();

    expect(writes).toEqual([
      "completed",
      "rejected:ASYNC_COMPLETION_PERSIST_FAILED",
    ]);
    // Publish spy: nothing was published for the command, anywhere.
    expect(events.filter((e) => e.payload?.id === id)).toEqual([]);
    expect(events.filter((e) => e.type === "command.result")).toEqual([]);
    expect(resultFrames(sub, id)).toEqual([]);
    expect(sub.frames.some((f) => f.payload?.id === id)).toBe(false);
    // Characterized HEAD behavior: the durable receipt stays "accepted".
    expect(host.store.commandReceipt(id)).toEqual({
      v: 1,
      id,
      status: "accepted",
    });
    expect(
      host.store
        .replay(sessionStream(), 0)
        .some((e: Row) => e.type === "command.result" && e.payload.id === id),
    ).toBe(false);

    // R19: the failed completion is a separate bounded blocker, not a pending job.
    const blocker = async () => {
      const health = await control(fixture.data, { type: "health" });
      return {
        health,
        entry: health.work.blockers.find(
          (b: Row) => b.kind === "completion-persistence",
        ),
      };
    };
    let seen = await blocker();
    expect(seen.entry).toEqual({ kind: "completion-persistence", count: 1 });
    expect(seen.health.activeWork).toBeGreaterThan(0);
    expect(JSON.stringify(seen.health)).not.toContain(id);

    const failedClose = host.close();
    await expect(failedClose).rejects.toMatchObject({
      code: "ASYNC_DRAIN_FAILED",
    });
    // Drain failed before child shutdown, storage close and lock release.
    expect(order).toEqual([]);
    expect(await probeLock()).toBe("busy");
    expect(host.children.has(sessionId)).toBe(true);
    expect(events.filter((e) => e.type === "command.result")).toEqual([]);
    // The blocker survives the first failed close: stopping health exposes it.
    seen = await blocker();
    expect(seen.health).toMatchObject({
      lifecycle: "stopping",
      shutdownStage: "drain",
    });
    expect(seen.entry).toEqual({ kind: "completion-persistence", count: 1 });
    expect(seen.health.activeWork).toBeGreaterThan(0);

    // R20: a second close under a persistent fault retries the drain, rejects
    // again and still owns the control socket and the lock.
    const retry = host.close();
    expect(retry).not.toBe(failedClose);
    expect(host.close()).toBe(retry);
    await expect(retry).rejects.toMatchObject({ code: "ASYNC_DRAIN_FAILED" });
    expect(writes).toEqual([
      "completed",
      "rejected:ASYNC_COMPLETION_PERSIST_FAILED",
      "rejected:ASYNC_COMPLETION_PERSIST_FAILED",
    ]);
    expect(order).toEqual([]);
    expect(await probeLock()).toBe("busy");
    expect((await blocker()).entry).toEqual({
      kind: "completion-persistence",
      count: 1,
    });
    expect(host.store.commandReceipt(id)?.status).toBe("accepted");

    // Restored storage: the next close is a new promise that settles the
    // durable rejection and its result event before the single release.
    receiptSpy?.mockRestore();
    const closing = host.close();
    expect(closing).not.toBe(retry);
    expect(host.close()).toBe(closing);
    await closing;
    expect(order).toEqual(["store.close"]);
    expect(
      events.filter((e) => e.type === "command.result").map((e) => e.payload),
    ).toEqual([
      {
        v: 1,
        id,
        status: "rejected",
        error: {
          code: "ASYNC_COMPLETION_PERSIST_FAILED",
          message: "The accepted operation could not persist its completion.",
          retryable: true,
        },
      },
    ]);
    expect(await probeLock()).toBe("locked");
    await expect(control(fixture.data, { type: "health" })).rejects.toThrow();
    expect(host.close()).toBe(closing);
    // Durable after release: one rejection receipt and one replayable result.
    const reopened = new Storage(fixture.data);
    try {
      expect(reopened.commandReceipt(id)?.error?.code).toBe(
        "ASYNC_COMPLETION_PERSIST_FAILED",
      );
      expect(
        reopened
          .replay(sessionStream(), 0)
          .filter(
            (e: Row) => e.type === "command.result" && e.payload.id === id,
          ),
      ).toHaveLength(1);
    } finally {
      reopened.close();
    }
  },
);

it("concurrent close retries share one drain and release ownership only once", async () => {
  skipFixtureClose = true;
  const { id, free } = await acceptHeld("session.resume");
  const writes = failTerminalReceipts(id, Infinity);
  const events = recordEvents();
  const order: string[] = [];
  const storeClose = fixture.host.store.close.bind(fixture.host.store);
  vi.spyOn(fixture.host.store, "close").mockImplementation(() => {
    order.push("store.close");
    storeClose();
  });
  const host = fixture.host;
  await free();
  await expect.poll(() => writes.length).toBe(2);

  // Concurrent closes share the first (reporting) drain and its rejection.
  const first = host.close();
  expect(host.close()).toBe(first);
  const settled = await Promise.allSettled([first, host.close()]);
  expect(settled.map((r) => r.status)).toEqual(["rejected", "rejected"]);
  expect(writes).toHaveLength(2);

  // Late ingress and bootstrap are refused; bounded health stays readable.
  const late = await host.execute(envelope("session.resume"), "fixture-client");
  expect(late).toMatchObject({
    status: "rejected",
    error: { code: "HOST_STOPPING" },
  });
  expect(
    await control(fixture.data, { type: "bootstrap" }).catch(() => ({
      error: "HOST_STOPPING",
    })),
  ).toMatchObject({ error: "HOST_STOPPING" });
  const health = await control(fixture.data, { type: "health" });
  expect(health).toMatchObject({ lifecycle: "stopping", hostPresent: true });
  expect(JSON.stringify(health)).not.toContain("synthetic");

  // Concurrent retries under the persistent fault share exactly one drain.
  const retries = [host.close(), host.close()];
  expect(retries[1]).toBe(retries[0]);
  expect(retries[0]).not.toBe(first);
  await expect(retries[0]).rejects.toMatchObject({
    code: "ASYNC_DRAIN_FAILED",
  });
  expect(writes).toHaveLength(3);
  expect(order).toEqual([]);
  expect(await probeLock()).toBe("busy");

  receiptSpy?.mockRestore();
  const [a, b] = [host.close(), host.close()];
  expect(a).toBe(b);
  await Promise.all([a, b, host.close()]);
  expect(order).toEqual(["store.close"]);
  expect(events.filter((e) => e.type === "command.result")).toHaveLength(1);
  expect(await probeLock()).toBe("locked");
  expect(host.close()).toBe(a);
  expect(order).toEqual(["store.close"]);
});

const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const finalMessage = (messageId: string, text: string) => ({
  messageId,
  role: "assistant",
  blocks: [{ kind: "text", id: `${messageId}:b`, text }],
  revision: 1,
  final: true,
});
const emitFromChild = (type: string, payload: Row) =>
  (fixture.host.children.get(sessionId)!.translator as any).emit(type, payload);

/** Delay only the selected artifact write; other assets pass through. */
function holdArtifact(path: "inline" | "large", marker: string) {
  const gate = deferred();
  const entered = deferred();
  const upload = Assets.prototype.upload;
  const output = Assets.prototype.output;
  const gated = async (selected: boolean) => {
    if (!selected) return;
    entered.resolve();
    await gate.promise;
  };
  vi.spyOn(Assets.prototype, "upload").mockImplementation(async function (
    this: Assets,
    ...args: Parameters<Assets["upload"]>
  ) {
    await gated(path === "inline" && args[5] === marker);
    return upload.apply(this, args);
  });
  vi.spyOn(Assets.prototype, "output").mockImplementation(async function (
    this: Assets,
    ...args: Parameters<Assets["output"]>
  ) {
    await gated(path === "large" && args[0].includes(marker));
    return output.apply(this, args);
  });
  return { gate, entered };
}

it.each(["inline", "large"] as const)(
  "%s artifact: a failed artifact.ready store.event publishes no success frame and leaves only a bounded ARTIFACT_UNAVAILABLE notice",
  async (path) => {
    await warm();
    const pid = pidOf();
    const sub = await subscribe();
    const marker = path === "inline" ? "image-fail" : "LARGE-FAIL";
    const { gate, entered } = holdArtifact(path, marker);
    const assetRows = () =>
      fixture.host.store
        .list("asset")
        .map((a: Row) => a.id)
        .sort();
    const assetFiles = () =>
      readdir(join(fixture.host.store.root, "assets"))
        .then((names) => names.sort())
        .catch(() => [] as string[]);
    const rowsBefore = assetRows();
    const filesBefore = await assetFiles();

    const attempts: Row[] = [];
    const persisted: Row[] = [];
    const original = fixture.host.store.event.bind(fixture.host.store);
    let failed = false;
    vi.spyOn(fixture.host.store, "event").mockImplementation(
      (stream: string, type: string, payload: any) => {
        if (
          stream === sessionStream() &&
          type === "artifact.ready" &&
          !failed
        ) {
          failed = true;
          attempts.push({
            type,
            headAtFailure: head(),
            projectionAtFailure: fixture.host.store.snapshot(sessionStream()),
          });
          throw new Error("synthetic event storage failure");
        }
        const event = original(stream, type, payload);
        if (stream === sessionStream())
          persisted.push({ type, payload, seq: event.seq });
        return event;
      },
    );

    if (path === "inline")
      emitFromChild("artifact.inline", {
        id: marker,
        data: PNG,
        mime: "image/png",
      });
    else
      emitFromChild(
        "message.upsert",
        finalMessage("big", marker + "x".repeat(400 * 1024)),
      );
    await entered.promise;
    const headBefore = head();
    const projectionBefore = fixture.host.store.snapshot(sessionStream());
    expect(await categories()).toContain("image-write");

    gate.resolve();
    const notice = await sub.next(
      (f) => f.type === "notice" && f.payload?.code === "ARTIFACT_UNAVAILABLE",
    );
    await expect
      .poll(async () => (await blockerKinds()).includes("image-writes"))
      .toBe(false);
    await turns();

    // The failing store.event ran once, saw the unchanged stream, and nothing
    // artifact.ready / success related was persisted or sent afterwards.
    expect(attempts).toHaveLength(1);
    expect(attempts[0].headAtFailure).toBe(headBefore);
    expect(attempts[0].projectionAtFailure).toEqual(projectionBefore);
    // Only the large branch retains the original message ahead of the notice.
    const large = path === "large";
    expect(persisted.map((e) => e.type)).toEqual(
      large ? ["message.upsert", "notice"] : ["notice"],
    );
    expect(sub.frames.filter((f) => f.type === "artifact.ready")).toEqual([]);
    expect(sub.frames.filter((f) => f.type === "message.upsert").length).toBe(
      large ? 1 : 0,
    );
    expect(notice.seq).toBe(headBefore + (large ? 2 : 1));
    expect(head()).toBe(headBefore + (large ? 2 : 1));
    // The uncommitted attempt left no newly owned row or file.
    expect(assetRows()).toEqual(rowsBefore);
    expect(await assetFiles()).toEqual(filesBefore);
    expect(notice.payload.code).toBe("ARTIFACT_UNAVAILABLE");
    expect(typeof notice.payload.text).toBe("string");
    expect(notice.payload.text.length).toBeLessThan(200);
    expect(JSON.stringify(notice)).not.toContain("synthetic");
    expect(JSON.stringify(notice)).not.toContain(marker);
    expect(Object.keys(notice.payload).sort()).toEqual(["code", "text"]);
    // Inline: notice only. Large: the full original text, never an artifact.
    const after = fixture.host.store.snapshot(sessionStream());
    if (large) {
      expect(JSON.stringify(after.messages)).toContain(
        marker + "x".repeat(400 * 1024),
      );
      expect(notice.payload.text).toBe(
        "Attachment not saved; the original message is retained.",
      );
    } else expect(after.messages).toEqual(projectionBefore.messages);
    expect(JSON.stringify(after)).not.toContain("artifactId");
    expect(
      fixture.host.store
        .replay(sessionStream(), headBefore)
        .map((e: Row) => e.type),
    ).toEqual(large ? ["message.upsert", "notice"] : ["notice"]);
    // The runtime is untouched and the write is no longer pending.
    expect(pidOf()).toBe(pid);
    expect(await categories()).toEqual([]);
    fixture.host.reapIdleRuntimes(FUTURE());
    await expect.poll(() => fixture.host.children.has(sessionId)).toBe(false);
  },
);

const assetState = async () => ({
  rows: fixture.host.store
    .list("asset")
    .map((a: Row) => a.id)
    .sort(),
  files: (
    await readdir(join(fixture.host.store.root, "assets")).catch(
      () => [] as string[],
    )
  ).sort(),
});

it("artifact rollback removes only the uncommitted blob and preserves ready or pre-existing assets", async () => {
  const assets = new Assets(fixture.host.store);
  const text = (n: string) => Buffer.from(`content ${n}`);
  const upload = (id?: string) =>
    assets.upload(
      text("a"),
      "a.txt",
      "text/plain",
      "attachment",
      sessionId,
      id,
    );

  // Asset put failure: the blob written for this attempt is removed.
  const clean = await assetState();
  const put = vi.spyOn(fixture.host.store, "put").mockImplementationOnce(() => {
    throw new Error("synthetic put failure");
  });
  await expect(assets.output("big", sessionId)).rejects.toThrow("synthetic");
  put.mockImplementationOnce(() => {
    throw new Error("synthetic put failure");
  });
  await expect(upload()).rejects.toThrow("synthetic");
  expect(await assetState()).toEqual(clean);

  // A pre-existing requestedId asset survives a failed re-upload and a discard.
  const existing = await upload("preexisting-asset");
  put.mockImplementationOnce(() => {
    throw new Error("synthetic put failure");
  });
  await expect(upload("preexisting-asset")).rejects.toThrow("synthetic");
  const again = await upload("preexisting-asset");
  await assets.discard(again);
  expect(fixture.host.store.get("asset", "preexisting-asset")).toEqual(
    existing,
  );
  expect(await assetState()).toEqual({
    rows: ["preexisting-asset"],
    files: ["preexisting-asset"],
  });
  // A discarded fresh asset is removed once; a second discard is a no-op.
  const fresh = await upload();
  await assets.discard(fresh);
  await assets.discard(fresh);
  expect((await assetState()).rows).toEqual(["preexisting-asset"]);
  put.mockRestore();

  // Ready-event failure removes the blob; preview-only failure keeps it.
  await warm();
  const marker = "ROLLBACK-LARGE";
  const original = fixture.host.store.event.bind(fixture.host.store);
  const failing = (kind: string) => {
    let failed = false;
    vi.spyOn(fixture.host.store, "event").mockImplementation(
      (stream: string, type: string, payload: any) => {
        if (stream === sessionStream() && type === kind && !failed) {
          failed = true;
          throw new Error("synthetic event failure");
        }
        return original(stream, type, payload);
      },
    );
  };
  const before = await assetState();
  failing("artifact.ready");
  emitFromChild(
    "message.upsert",
    finalMessage("rb1", marker + "x".repeat(400 * 1024)),
  );
  await expect.poll(async () => (await categories()).length).toBe(0);
  expect(await assetState()).toEqual(before);
  vi.restoreAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});

  failing("message.upsert");
  emitFromChild(
    "message.upsert",
    finalMessage("rb2", marker + "y".repeat(400 * 1024)),
  );
  await expect.poll(async () => (await categories()).length).toBe(0);
  await turns();
  const kept = await assetState();
  expect(kept.rows).toHaveLength(before.rows.length + 1);
  expect(kept.files).toHaveLength(before.files.length + 1);
  const ready = fixture.host.store
    .replay(sessionStream(), 0)
    .filter((e: Row) => e.type === "artifact.ready");
  expect(ready).toHaveLength(1);
  expect(kept.rows).toContain(ready[0].payload.id);
  expect(kept.files).toContain(ready[0].payload.id);
});

it("artifact fallback preserves original text and never reports a failed secondary write as saved", async () => {
  await warm();
  const text = "FALLBACK-" + "z".repeat(400 * 1024);
  const original = fixture.host.store.event.bind(fixture.host.store);
  const seen: Row[] = [];
  let mode: "ready" | "all" = "ready";
  vi.spyOn(fixture.host.store, "event").mockImplementation(
    (stream: string, type: string, payload: any) => {
      if (stream === sessionStream()) {
        if (type === "artifact.ready") throw new Error("synthetic ready");
        if (mode === "all" && (type === "message.upsert" || type === "notice"))
          throw new Error("synthetic secondary");
        seen.push({ type, payload });
      }
      return original(stream, type, payload);
    },
  );
  const rows = () =>
    seen
      .filter((r) => ["message.upsert", "notice"].includes(r.type))
      .map((r) =>
        r.type === "notice"
          ? `notice:${r.payload.code}`
          : `message:${r.payload.messageId}`,
      );

  // Primary failure: original text first, then notice, ahead of the follow-on.
  emitFromChild("message.upsert", finalMessage("orig", text));
  emitFromChild("message.upsert", finalMessage("next", "follow-on"));
  await expect.poll(() => rows().length).toBe(3);
  expect(rows()).toEqual([
    "message:orig",
    "notice:ARTIFACT_UNAVAILABLE",
    "message:next",
  ]);
  const stored = seen.find((r) => r.payload.messageId === "orig")!;
  expect(stored.payload.blocks[0].text).toBe(text);
  expect(JSON.stringify(stored.payload)).not.toContain("artifactId");
  const noticeRow = seen.find((r) => r.type === "notice")!;
  expect(noticeRow.payload.text).toBe(
    "Attachment not saved; the original message is retained.",
  );
  expect(noticeRow.payload.text).not.toContain("FALLBACK");

  // Secondary failure: nothing claims the original was saved; close fails closed.
  mode = "all";
  seen.length = 0;
  emitFromChild("message.upsert", finalMessage("lost", text + "!"));
  await expect.poll(async () => (await categories()).length).toBe(0);
  await turns();
  expect(rows()).toEqual([]);
  expect(JSON.stringify(seen)).not.toContain("retained");
  skipFixtureClose = true;
  await expect(fixture.host.close()).rejects.toMatchObject({
    code: "ARTIFACT_FALLBACK_PERSIST_FAILED",
  });
});

it.each(["inline", "large"] as const)(
  "%s artifact: a socket fanout failure after the durable artifact.ready commit keeps the referenced asset",
  async (path) => {
    await warm();
    const sub = await subscribe();
    const before = await assetState();
    // Only the server-side send of the ready frame throws; store.event succeeded.
    const send = WebSocket.prototype.send;
    vi.spyOn(WebSocket.prototype, "send").mockImplementation(function (
      this: WebSocket,
      data: any,
      ...rest: any[]
    ) {
      if (typeof data === "string" && data.includes('"artifact.ready"'))
        throw new Error("synthetic fanout failure");
      return (send as any).call(this, data, ...rest);
    } as any);
    if (path === "inline")
      emitFromChild("artifact.inline", {
        id: "fanout-inline",
        data: PNG,
        mime: "image/png",
      });
    else
      emitFromChild(
        "message.upsert",
        finalMessage("fan", "FANOUT" + "x".repeat(400 * 1024)),
      );
    await expect.poll(async () => (await categories()).length).toBe(0);
    await turns();
    const ready = fixture.host.store
      .replay(sessionStream(), 0)
      .filter((e: Row) => e.type === "artifact.ready");
    expect(ready).toHaveLength(1);
    const after = await assetState();
    expect(after.rows).toContain(ready[0].payload.id);
    expect(after.files).toContain(ready[0].payload.id);
    expect(after.rows).toHaveLength(before.rows.length + 1);
    expect(after.files).toHaveLength(before.files.length + 1);
    // No failure notice or fallback: the artifact was committed.
    expect(
      sub.frames.filter(
        (f) =>
          f.type === "notice" && f.payload?.code === "ARTIFACT_UNAVAILABLE",
      ),
    ).toEqual([]);
  },
);

it("artifact fallback whose notice cannot persist settles without an unhandled rejection and fails close", async () => {
  await warm();
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  try {
    const original = fixture.host.store.event.bind(fixture.host.store);
    const types: string[] = [];
    vi.spyOn(fixture.host.store, "event").mockImplementation(
      (stream: string, type: string, payload: any) => {
        if (stream === sessionStream()) {
          if (type === "artifact.ready" || type === "notice")
            throw new Error("synthetic " + type);
          types.push(type);
        }
        return original(stream, type, payload);
      },
    );
    emitFromChild(
      "message.upsert",
      finalMessage("kept", "NOTICE-FAIL" + "x".repeat(400 * 1024)),
    );
    await expect.poll(async () => (await categories()).length).toBe(0);
    await turns();
    await new Promise((r) => setTimeout(r, 20));
    expect(types).toContain("message.upsert");
    expect(unhandled).toEqual([]);
    skipFixtureClose = true;
    await expect(fixture.host.close()).rejects.toMatchObject({
      code: "ARTIFACT_FALLBACK_PERSIST_FAILED",
    });
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});
