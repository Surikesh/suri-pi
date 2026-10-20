import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile, chmod } from "node:fs/promises";
import { join, resolve } from "node:path";
import { browserHost } from "../support/browser-host.js";
import { control } from "../../apps/host/src/cli.js";
import { Assets } from "../../apps/host/src/assets.js";

// Pre-move characterization of idle retirement vs. boot / submission / image
// work (apps/host/src/host.ts reapIdleRuntimes, startSession, submissions,
// imageWrites, protectedWork, close). No production seam: the fixture Pi is a
// patched copy of tests/fixtures/fake-pi.mjs that holds selected responses and
// its own exit behind gate files, and logs spawns and RPC calls per PID. Image
// work is delayed by spying Assets.prototype. Ordering uses deferred gates and
// polls on observable state, never sleeps. Where HEAD looks odd the test
// asserts what it actually does ("characterized HEAD behavior").

type Fixture = Awaited<ReturnType<typeof browserHost>>;
type Row = Record<string, any>;

let fixture: Fixture;
let gates: string;
let sessionId: string;

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
const spawns = () => jsonl("spawns.jsonl");
const calls = (type?: string) =>
  jsonl("calls.jsonl").then((rows) =>
    type ? rows.filter((row) => row.type === type) : rows,
  );

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
}
const turns = async (count = 20) => {
  for (let i = 0; i < count; i++) await new Promise((r) => setImmediate(r));
};

/** Patched copy of the fixture Pi (gated responses, gated exit, call logs). */
async function installGatedPi(root: string) {
  const source = await readFile("tests/fixtures/fake-pi.mjs", "utf8");
  const G = JSON.stringify(gates);
  const emitDefinition = `const emit = (value) => process.stdout.write(JSON.stringify(value) + "\\n");`;
  const callLine = `const c = JSON.parse(line);`;
  expect(source).toContain(emitDefinition);
  expect(source).toContain(callLine);
  const patched = source
    .replace(
      emitDefinition,
      `import { existsSync as __exists, appendFileSync as __append } from "node:fs";
const __G = ${G};
__append(join(__G, "spawns.jsonl"), JSON.stringify({ pid: process.pid, file }) + "\\n");
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
};
process.stdin.on("end", () => {
  // Hold process exit while the exit gate exists (previous writer stays live).
  setInterval(() => { if (!__exists(join(__G, "hold-exit"))) process.exit(0); }, 2);
});`,
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

const sessionRow = () => fixture.host.store.get("session", sessionId);
const phase = () => fixture.host.store.snapshot(`session:${sessionId}`).phase;
async function owner(): Promise<Row | undefined> {
  const health = await control(fixture.data, { type: "health" });
  return health.work.blockers
    .find((blocker: Row) => blocker.kind === "sessions-or-rpc")
    ?.owners?.find((item: Row) => item.owner === sessionId);
}
async function categories(): Promise<string[]> {
  return (await owner())?.categories ?? [];
}
async function blockerKinds(): Promise<string[]> {
  const health = await control(fixture.data, { type: "health" });
  return health.work.blockers.map((blocker: Row) => blocker.kind);
}
const settled = async () => {
  const health = await control(fixture.data, { type: "health" });
  return health.activeWork;
};

/** Boot the session once and wait until it is idle with a recorded piFile. */
async function warm() {
  await fixture.execute("session.resume", {}, sessionId);
  await expect.poll(() => fixture.host.children.has(sessionId)).toBe(true);
  await expect.poll(() => phase()).toBe("idle");
  await expect.poll(async () => await settled()).toBe(0);
  expect(sessionRow().piFile).toEqual(expect.any(String));
}
/** Retire the (idle) live child via the reaper and wait for its exit. */
async function cool() {
  fixture.host.reapIdleRuntimes(FUTURE());
  await expect.poll(() => fixture.host.children.has(sessionId)).toBe(false);
  await expect.poll(() => phase()).toBe("closed");
}
const submit = (text: string) =>
  fixture.execute(
    "run.submit",
    { text, mode: "prompt", attachmentIds: [] },
    sessionId,
  );
/** Executes a command and exposes its accepted receipt; terminal result via events. */
const command = (type: string, payload: Row = {}, id = crypto.randomUUID()) =>
  fixture.host.execute(
    {
      v: 1,
      id,
      createdAt: new Date().toISOString(),
      type,
      payload,
      sessionId,
    },
    "fixture-client",
  );
const terminal = (seen: Row[], id: string) =>
  seen
    .filter((row) => row.type === "command.result" && row.payload.id === id)
    .map((row) => row.payload.status);
const prompts = async () => (await calls("prompt")).map((row) => row.message);
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

beforeEach(async () => {
  fixture = await browserHost();
  gates = join(fixture.root, "gates");
  await mkdir(gates);
  await writeFile(join(gates, "spawns.jsonl"), "");
  await installGatedPi(fixture.root);
  sessionId = fixture.session.id;
});
afterEach(async () => {
  await Promise.all(
    ["get_state", "prompt", "exit"].map((name) => release(name)),
  );
  vi.restoreAllMocks();
  await fixture.close();
});

it("keeps a held get_state boot alive through the reaper; one boot per session, same piFile", async () => {
  await warm();
  const piFile = sessionRow().piFile;
  await cool();
  expect(await spawns()).toHaveLength(1);

  const seen = recordEvents();
  await hold("get_state");
  const getStates = (await calls("get_state")).length;
  await fixture.execute("session.resume", {}, sessionId);
  await expect
    .poll(async () => (await calls("get_state")).length)
    .toBe(getStates + 1);
  // A second session.resume joins the owned boot: accepted, but it has no
  // terminal result (acceptance is not boot completion) until the boot settles.
  const resumeId = crypto.randomUUID();
  expect((await command("session.resume", {}, resumeId)).status).toBe(
    "accepted",
  );
  await turns();
  expect(terminal(seen, resumeId)).toEqual([]);
  const joined = fixture.execute("model.list", {}, sessionId);
  const joinedAgain = fixture.execute("commands.list", {}, sessionId);
  expect(fixture.host.children.has(sessionId)).toBe(true);
  expect(await spawns()).toHaveLength(2);

  // Health projects the boot (and its pending RPC) until the gate settles.
  expect(await categories()).toEqual(expect.arrayContaining(["boot", "rpc"]));
  expect(await settled()).toBeGreaterThan(0);

  fixture.host.reapIdleRuntimes(FUTURE());
  await turns();
  expect(fixture.host.children.has(sessionId)).toBe(true);
  expect(await categories()).not.toContain("retirement");
  expect((await spawns()).length).toBe(2);
  expect((await calls("get_state")).length).toBe(getStates + 1);

  await release("get_state");
  await Promise.allSettled([joined, joinedAgain]);
  await expect.poll(() => phase()).toBe("idle");
  await expect.poll(async () => await settled()).toBe(0);
  expect(terminal(seen, resumeId)).toEqual(["completed"]);
  // One boot: every get_state after the cold start came from a single child.
  const bootCalls = (await calls("get_state")).slice(getStates);
  expect(new Set(bootCalls.map((row) => row.pid)).size).toBe(1);
  expect(await categories()).toEqual([]);
  expect(await spawns()).toHaveLength(2);
  expect(sessionRow().piFile).toBe(piFile);
  expect(sessionRow().processPid).toBe(pidOf());

  // Once the boot has settled the runtime is idle again and retires normally.
  fixture.host.reapIdleRuntimes(FUTURE());
  await expect.poll(() => fixture.host.children.has(sessionId)).toBe(false);
  expect(sessionRow().piFile).toBe(piFile);
});

it("protects a cold submit while its boot is held and sends exactly one prompt", async () => {
  await warm();
  const piFile = sessionRow().piFile;
  await cool();

  const seen = recordEvents();
  await hold("get_state");
  const before = (await calls("get_state")).length;
  await submit("cold prompt");
  await expect
    .poll(async () => (await calls("get_state")).length)
    .toBe(before + 1);
  // A concurrent resume joins the boot instead of spawning a second writer.
  const resumeId = crypto.randomUUID();
  expect((await command("session.resume", {}, resumeId)).status).toBe(
    "accepted",
  );
  await turns();
  expect(terminal(seen, resumeId)).toEqual([]);
  expect(await categories()).toEqual(
    expect.arrayContaining(["boot", "submission", "rpc"]),
  );
  fixture.host.reapIdleRuntimes(FUTURE());
  await turns();
  expect(fixture.host.children.has(sessionId)).toBe(true);
  expect(await categories()).not.toContain("retirement");
  expect(await prompts()).toEqual([]);
  expect(await spawns()).toHaveLength(2);

  await release("get_state");
  await expect.poll(async () => await prompts()).toEqual(["cold prompt"]);
  await expect.poll(async () => await settled()).toBe(0);
  expect(terminal(seen, resumeId)).toEqual(["completed"]);
  const bootCalls = (await calls("get_state")).slice(before);
  expect(new Set(bootCalls.map((row) => row.pid)).size).toBe(1);
  expect(await spawns()).toHaveLength(2);
  expect(sessionRow().piFile).toBe(piFile);
  expect(await prompts()).toEqual(["cold prompt"]);
});

it("protects an accepted run.submit while the prompt response is held", async () => {
  await warm();
  const pid = pidOf();
  await hold("prompt");
  const receipt = await fixture.host.execute(
    {
      v: 1,
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      type: "run.submit",
      payload: { text: "held prompt", mode: "prompt", attachmentIds: [] },
      sessionId,
    },
    "fixture-client",
  );
  expect(receipt.status).toBe("accepted");
  await expect.poll(async () => await prompts()).toEqual(["held prompt"]);

  expect(await categories()).toEqual(
    expect.arrayContaining(["submission", "rpc"]),
  );
  fixture.host.reapIdleRuntimes(FUTURE());
  await turns();
  expect(fixture.host.children.has(sessionId)).toBe(true);
  expect(pidOf()).toBe(pid);
  expect(await categories()).not.toContain("retirement");
  expect(await settled()).toBeGreaterThan(0);

  await release("prompt");
  await expect.poll(async () => await settled()).toBe(0);
  expect(await prompts()).toEqual(["held prompt"]);
  expect(await spawns()).toHaveLength(1);
  expect(fixture.host.children.has(sessionId)).toBe(true);
});

it("protects the pre-prompt window (assets.prompt held): submission owner, no retirement, one prompt to the original PID", async () => {
  await warm();
  const firstPid = pidOf();
  const gate = deferred();
  const original = Assets.prototype.prompt;
  const entered = deferred();
  vi.spyOn(Assets.prototype, "prompt").mockImplementation(async function (
    this: Assets,
    ...args: Parameters<Assets["prompt"]>
  ) {
    entered.resolve();
    await gate.promise;
    return original.apply(this, args);
  });
  await hold("exit");
  const accepted = submit("window prompt");
  await entered.promise;

  // The reservation exists before the awaited prompt work: the reaper skips
  // the runtime and nothing is retired or respawned.
  expect(await categories()).toEqual(["submission"]);
  fixture.host.reapIdleRuntimes(FUTURE());
  expect(await categories()).not.toContain("retirement");
  await turns();
  expect(await spawns()).toHaveLength(1);
  expect(pidOf()).toBe(firstPid);
  expect(await prompts()).toEqual([]);

  gate.resolve();
  await accepted;
  await expect.poll(async () => await prompts()).toEqual(["window prompt"]);
  await expect.poll(async () => await settled()).toBe(0);
  expect(await spawns()).toHaveLength(1);
  expect(pidOf()).toBe(firstPid);
  expect((await calls("prompt")).map((row) => row.pid)).toEqual([firstPid]);
});

it("prompt preparation failure releases submission protection", async () => {
  await warm();
  const firstPid = pidOf();
  const original = Assets.prototype.prompt;
  let failNext = true;
  vi.spyOn(Assets.prototype, "prompt").mockImplementation(async function (
    this: Assets,
    ...args: Parameters<Assets["prompt"]>
  ) {
    if (failNext) {
      failNext = false;
      throw new Error("synthetic prompt fault");
    }
    return original.apply(this, args);
  });
  // Lone assets fault: protection is released, so idle reaping works again.
  await expect(submit("fails")).rejects.toThrow();
  expect(await owner()).toBeUndefined();
  fixture.host.reapIdleRuntimes(FUTURE());
  await expect.poll(() => fixture.host.children.has(sessionId)).toBe(false);
  expect(await prompts()).toEqual([]);

  // Overlapping reservations release per submit: hold the first one.
  await warm();
  const heldPid = pidOf();
  expect(heldPid).not.toBe(firstPid);
  await hold("prompt");
  await submit("held");
  await expect.poll(async () => await prompts()).toEqual(["held"]);
  // Extension-discovery fault in the second, overlapping submission.
  const child = fixture.host.children.get(sessionId)!;
  const request = child.request.bind(child);
  vi.spyOn(child, "request").mockImplementation(((
    type: string,
    ...rest: any[]
  ) =>
    type === "get_commands"
      ? Promise.reject(new Error("synthetic discovery fault"))
      : request(type as any, ...(rest as []))) as any);
  await expect(
    fixture.execute(
      "run.submit",
      {
        text: "/ext",
        mode: "prompt",
        attachmentIds: [],
        immediateExtension: true,
      },
      sessionId,
    ),
  ).rejects.toThrow();
  expect(await categories()).toEqual(
    expect.arrayContaining(["submission", "rpc"]),
  );
  fixture.host.reapIdleRuntimes(FUTURE());
  await turns();
  expect(fixture.host.children.has(sessionId)).toBe(true);
  // Assets fault in a third overlapping (steer) submission.
  failNext = true;
  await expect(
    fixture.execute(
      "run.submit",
      { text: "steer", mode: "steer", attachmentIds: [] },
      sessionId,
    ),
  ).rejects.toThrow();
  fixture.host.reapIdleRuntimes(FUTURE());
  await turns();
  expect(fixture.host.children.has(sessionId)).toBe(true);
  expect(pidOf()).toBe(heldPid);
  expect(await categories()).toContain("submission");

  // Only the surviving reservation remains; its job finally releases it.
  await release("prompt");
  await expect.poll(async () => await settled()).toBe(0);
  expect(await owner()).toBeUndefined();
  fixture.host.reapIdleRuntimes(FUTURE());
  await expect.poll(() => fixture.host.children.has(sessionId)).toBe(false);
  expect(await prompts()).toEqual(["held"]);
});

it("coalesced resumes share boot failure but active runs still reject resume", async () => {
  await warm();
  await cool();
  const seen = recordEvents();
  await hold("get_state");
  const before = (await calls("get_state")).length;
  const first = crypto.randomUUID();
  const second = crypto.randomUUID();
  expect((await command("session.resume", {}, first)).status).toBe("accepted");
  await expect
    .poll(async () => (await calls("get_state")).length)
    .toBe(before + 1);
  expect((await command("session.resume", {}, second)).status).toBe("accepted");
  await turns();
  expect(terminal(seen, first)).toEqual([]);
  expect(terminal(seen, second)).toEqual([]);
  expect(await spawns()).toHaveLength(2);

  // The held boot dies: both waiters fail from the same boot, no new child.
  const bootPid = (await spawns())[1].pid;
  process.kill(bootPid, "SIGKILL");
  await expect.poll(() => terminal(seen, first)).toEqual(["rejected"]);
  await expect.poll(() => terminal(seen, second)).toEqual(["rejected"]);
  expect((await calls("get_state")).length).toBe(before + 1);
  expect(await spawns()).toHaveLength(2);
  expect(fixture.host.children.has(sessionId)).toBe(false);
  await release("get_state");

  // An active (non-boot) run still rejects resume with BUSY.
  await warm();
  emitFromChild("run.state", { phase: "running" });
  expect(phase()).toBe("running");
  await expect(
    fixture.execute("session.resume", {}, sessionId),
  ).rejects.toThrow("Stop the current run");
  expect((await spawns()).length).toBe(3);
});

it("serializes concurrent resume + submit behind an initiated retirement into one replacement", async () => {
  await warm();
  const piFile = sessionRow().piFile;
  const firstPid = pidOf();
  await hold("exit");
  fixture.host.reapIdleRuntimes(FUTURE());
  expect(await categories()).toContain("retirement");

  // Both commands are accepted while the previous writer is still alive.
  await Promise.all([
    fixture.execute("session.resume", {}, sessionId),
    submit("after retirement"),
  ]);
  await turns();
  // No second live writer while the previous exit is held.
  expect(await spawns()).toHaveLength(1);
  expect(fixture.host.children.get(sessionId)!.child.pid).toBe(firstPid);
  expect(await prompts()).toEqual([]);
  expect(await categories()).toEqual(
    expect.arrayContaining(["retirement", "submission"]),
  );
  expect(await settled()).toBeGreaterThan(0);

  await release("exit");
  await expect.poll(async () => await prompts()).toEqual(["after retirement"]);
  await expect.poll(async () => await settled()).toBe(0);
  const rows = await spawns();
  expect(rows).toHaveLength(2);
  expect(rows[1].pid).not.toBe(firstPid);
  expect(pidOf()).toBe(rows[1].pid);
  expect(sessionRow().processPid).toBe(rows[1].pid);
  expect(sessionRow().piFile).toBe(piFile);
  expect(rows[1].file).toBe(piFile);
  expect(await prompts()).toHaveLength(1);
  expect(await categories()).toEqual([]);
});

type Variant = {
  name: string;
  path: "inline" | "large";
  fail: boolean;
};
const variants: Variant[] = [
  { name: "inline image success", path: "inline", fail: false },
  { name: "inline image rejection", path: "inline", fail: true },
  { name: "oversized output success", path: "large", fail: false },
  { name: "oversized output rejection", path: "large", fail: true },
];
const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const finalMessage = (messageId: string, text: string, extra: Row = {}) => ({
  messageId,
  role: "assistant",
  blocks: [{ kind: "text", id: `${messageId}:b`, text }],
  revision: 1,
  final: true,
  ...extra,
});
/** Delay only the selected artifact write; other assets pass through. */
function holdArtifact(path: Variant["path"], fail: boolean, marker: string) {
  const gate = deferred();
  const entered = deferred();
  const upload = Assets.prototype.upload;
  const output = Assets.prototype.output;
  const gated = async (selected: boolean) => {
    if (!selected) return;
    entered.resolve();
    await gate.promise;
    if (fail) throw new Error("synthetic artifact failure");
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
const emitFromChild = (type: string, payload: Row) =>
  (fixture.host.children.get(sessionId)!.translator as any).emit(type, payload);
function recordEvents(order?: string[]) {
  const seen: Row[] = [];
  const original = fixture.host.store.event.bind(fixture.host.store);
  vi.spyOn(fixture.host.store, "event").mockImplementation(
    (stream: string, type: string, payload: any) => {
      if (stream === `session:${sessionId}`) {
        seen.push({ type, payload });
        const kind = frameKinds([{ type, payload }])[0];
        if (kind) order?.push(kind);
      }
      return original(stream, type, payload);
    },
  );
  return seen;
}
function frameKinds(seen: Row[]) {
  return seen
    .filter((row) =>
      ["artifact.ready", "notice", "message.upsert"].includes(row.type),
    )
    .map((row) =>
      row.type === "notice"
        ? `notice:${row.payload.code}`
        : row.type === "message.upsert"
          ? `message:${row.payload.messageId}`
          : row.type,
    );
}

it.each(variants)(
  "$name: image write blocks idle close, is projected, and publishes ordered frames after the gate",
  async ({ path, fail }) => {
    await warm();
    const pid = pidOf();
    const marker = path === "inline" ? "image-1" : "LARGE-MARKER";
    const { gate, entered } = holdArtifact(path, fail, marker);
    const seen = recordEvents();

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
    // A later small final message must wait behind the pending artifact.
    emitFromChild("message.upsert", finalMessage("after", "done"));

    expect(await categories()).toEqual(expect.arrayContaining(["image-write"]));
    expect(await blockerKinds()).toContain("image-writes");
    fixture.host.reapIdleRuntimes(FUTURE());
    await turns();
    expect(fixture.host.children.has(sessionId)).toBe(true);
    expect(pidOf()).toBe(pid);
    expect(await categories()).not.toContain("retirement");
    expect(frameKinds(seen)).toEqual([]);

    gate.resolve();
    await expect
      .poll(async () => (await blockerKinds()).includes("image-writes"))
      .toBe(false);
    await expect.poll(() => frameKinds(seen).length).toBeGreaterThan(1);
    await turns();
    const frames = frameKinds(seen);
    if (path === "inline")
      expect(frames).toEqual(
        fail
          ? ["notice:ARTIFACT_UNAVAILABLE", "message:after"]
          : ["artifact.ready", "message:after"],
      );
    else
      expect(frames).toEqual(
        fail
          ? ["message:big", "notice:ARTIFACT_UNAVAILABLE", "message:after"]
          : ["artifact.ready", "message:big", "message:after"],
      );
    if (!fail && path === "large") {
      const preview = seen.find(
        (row) =>
          row.type === "message.upsert" && row.payload.messageId === "big",
      )!;
      expect(preview.payload.blocks[0].artifactId).toEqual(expect.any(String));
      expect(preview.payload.text).toBeUndefined();
    }
    await expect.poll(async () => await categories()).toEqual([]);
    expect(fixture.host.children.has(sessionId)).toBe(true);

    // After the gate settled the idle runtime retires normally.
    fixture.host.reapIdleRuntimes(FUTURE());
    await expect.poll(() => fixture.host.children.has(sessionId)).toBe(false);
  },
);

it.each(variants.filter((v) => !v.fail))(
  "$name: close waits for the pending write before storage close and lock release",
  async ({ path }) => {
    await warm();
    const marker = path === "inline" ? "image-close" : "LARGE-CLOSE";
    const { gate, entered } = holdArtifact(path, false, marker);
    const order: string[] = [];
    const seen = recordEvents(order);
    const storeClose = fixture.host.store.close.bind(fixture.host.store);
    vi.spyOn(fixture.host.store, "close").mockImplementation(() => {
      order.push("store.close");
      storeClose();
    });
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
    // A later small message is an owned continuation of the pending write.
    emitFromChild("message.upsert", finalMessage("after", "done"));

    const closing = fixture.host.close().then(() => order.push("closed"));
    // Children are closed first; the image drain follows.
    await expect.poll(() => fixture.host.children.size).toBe(0);
    await turns(50);
    expect(order).toEqual([]);
    expect(await probeLock()).toBe("busy");

    order.push("release-gate");
    gate.resolve();
    await closing;
    // The drained write and its follow-on persist in order before storage
    // close and lock release; they are replayable, not sent to closed sockets.
    expect(order).toEqual([
      "release-gate",
      "artifact.ready",
      ...(path === "large" ? ["message:big"] : []),
      "message:after",
      "store.close",
      "closed",
    ]);
    expect(await probeLock()).toBe("locked");
    expect(frameKinds(seen)).toEqual(
      order.filter(
        (kind) => kind.startsWith("message:") || kind === "artifact.ready",
      ),
    );
  },
);

it("close drains accepted image continuations but rejects new emissions", async () => {
  await warm();
  const { gate, entered } = holdArtifact("inline", false, "image-held");
  const order: string[] = [];
  const seen = recordEvents(order);
  const storeClose = fixture.host.store.close.bind(fixture.host.store);
  vi.spyOn(fixture.host.store, "close").mockImplementation(() => {
    order.push("store.close");
    storeClose();
  });
  const uploads = Assets.prototype.upload as unknown as {
    mock: { calls: unknown[] };
  };
  emitFromChild("artifact.inline", {
    id: "image-held",
    data: PNG,
    mime: "image/png",
  });
  await entered.promise;
  emitFromChild("message.upsert", finalMessage("after", "queued behind image"));
  // Pre-close buffered intermediate assistant message.
  emitFromChild("message.upsert", {
    messageId: "buffered",
    role: "assistant",
    blocks: [{ kind: "text", id: "buffered:b", text: "partial" }],
    revision: 1,
    final: false,
  });
  const uploadCalls = uploads.mock.calls.length;

  const closing = fixture.host.close().then(() => order.push("closed"));
  // Admission is captured at entry: new emissions after close are rejected.
  emitFromChild("message.upsert", finalMessage("late", "too late"));
  emitFromChild("artifact.inline", {
    id: "late-image",
    data: PNG,
    mime: "image/png",
  });
  emitFromChild("notice", { code: "LATE", text: "late" });
  await expect.poll(() => fixture.host.children.size).toBe(0);
  await expect.poll(() => order.includes("message:buffered")).toBe(true);
  expect(order).toEqual(["message:buffered"]);

  order.push("release-gate");
  gate.resolve();
  await closing;
  expect(order).toEqual([
    "message:buffered",
    "release-gate",
    "artifact.ready",
    "message:after",
    "store.close",
    "closed",
  ]);
  expect(uploads.mock.calls.length).toBe(uploadCalls);
  expect(frameKinds(seen)).not.toContain("message:late");
  expect(frameKinds(seen)).not.toContain("notice:LATE");
});
