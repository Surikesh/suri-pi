import { afterEach, beforeEach, expect, it, vi } from "vitest";
import WebSocket from "ws";
import {
  installSeams,
  removeSeams,
  seedSession,
  wireFixture,
  type WireFixture,
} from "../support/host-wire-capture.js";

// Scheduling trace for the pre-F3c host: synchronous store effects interleaved
// with queueMicrotask/setImmediate sentinels. Only Date, crypto.randomUUID and
// crypto.randomBytes are seeded; timers and microtasks are real. Expectations
// are frozen inline literals and must not be regenerated after the move.
let f: WireFixture;
let trace: string[];
beforeEach(async () => {
  installSeams();
  f = await wireFixture();
  trace = [];
});
afterEach(async () => {
  await f.cleanup();
  removeSeams();
});

/** Records every durable store effect, in call order, by name only. */
function watchStore(labels: Map<string, string> = new Map()) {
  const store = f.host.store as any;
  const wrap = (name: string, label: (args: any[]) => string) => {
    const original = store[name].bind(store);
    vi.spyOn(store, name).mockImplementation((...args: any[]) => {
      trace.push(label(args));
      return original(...args);
    });
  };
  wrap("put", ([kind]) => `put:${kind}`);
  wrap("patch", ([kind]) => `patch:${kind}`);
  wrap("remove", ([kind]) => `remove:${kind}`);
  wrap(
    "event",
    ([stream, type]) => `event:${stream.replace(/:.*/, "")}:${type}`,
  );
  wrap(
    "receipt",
    ([receipt]) =>
      `receipt:${labels.get(receipt.id) ?? receipt.id}:${receipt.status}`,
  );
}
/** Microtask chain M1..Mn and macrotask sentinel I1 scheduled in the caller's turn. */
function sentinels(microtasks = 8) {
  let n = 0;
  const tick = () => {
    trace.push(`M${++n}`);
    if (n < microtasks) queueMicrotask(tick);
  };
  queueMicrotask(tick);
  setImmediate(() => trace.push("I1"));
}
const nextMacrotask = () =>
  new Promise<void>((resolve) => setImmediate(resolve));

it("traces a synchronous command: effects relative to microtask and immediate sentinels", async () => {
  const login = await f.login();
  await seedSession(f, login);
  const create = f.envelope("section.create", { label: "Trace" });
  const catalog = f.envelope("catalog.get");
  watchStore(
    new Map([
      [create.id, "section.create"],
      [catalog.id, "catalog.get"],
    ]),
  );
  trace.push("call");
  const running = f.host.execute(create as any, "trace-client");
  const pure = f.host.execute(catalog as any, "trace-client");
  trace.push("returned");
  sentinels();
  const [a, b] = await Promise.all([running, pure]);
  trace.push(`resolved:${a.status},${b.status}`);
  await nextMacrotask();
  trace.push("after-macrotask");
  expect(trace).toMatchInlineSnapshot(`
    [
      "call",
      "returned",
      "put:section",
      "event:catalog:catalog.section",
      "receipt:section.create:completed",
      "receipt:catalog.get:completed",
      "M1",
      "M2",
      "M3",
      "M4",
      "M5",
      "resolved:completed,completed",
      "M6",
      "M7",
      "M8",
      "I1",
      "after-macrotask",
    ]
  `);
});

it("traces serialization, bypass and pure commands submitted in one turn", async () => {
  const login = await f.login();
  const { session } = await seedSession(f, login);
  const labels = new Map<string, string>();
  const make = (
    label: string,
    type: string,
    payload: Record<string, unknown>,
    sessionId?: string,
  ) => {
    const envelope = f.envelope(
      type,
      payload,
      sessionId ? { sessionId, expectedRevision: 0 } : {},
    );
    labels.set(envelope.id, label);
    return envelope as any;
  };
  watchStore(labels);
  const batch = [
    make(
      "A:draft.save",
      "draft.save",
      { text: "a", attachmentIds: [] },
      session.id,
    ),
    make(
      "B:draft.save(same session, serialized behind A)",
      "draft.save",
      { text: "b", attachmentIds: [] },
      session.id,
    ),
    make(
      "C:interaction.respond(bypass)",
      "interaction.respond",
      { interactionId: "none", value: true },
      session.id,
    ),
    make("D:catalog.get(pure)", "catalog.get", {}),
    make("E:run.cancel(bypass)", "run.cancel", {}, session.id),
    make("F:section.create(no session)", "section.create", { label: "F" }),
  ];
  trace.push("call");
  const results = batch.map((envelope: any) =>
    f.host
      .execute(envelope, "trace-client")
      .then((r) => (trace.push(`resolved:${labels.get(envelope.id)}`), r)),
  );
  trace.push("returned");
  sentinels(12);
  await Promise.all(results);
  await nextMacrotask();
  trace.push("after-macrotask");
  expect(trace).toMatchInlineSnapshot(`
    [
      "call",
      "returned",
      "receipt:C:interaction.respond(bypass):rejected",
      "receipt:D:catalog.get(pure):completed",
      "put:section",
      "event:catalog:catalog.section",
      "receipt:F:section.create(no session):completed",
      "M1",
      "put:draft",
      "receipt:A:draft.save:completed",
      "M2",
      "M3",
      "M4",
      "resolved:C:interaction.respond(bypass)",
      "resolved:D:catalog.get(pure)",
      "resolved:E:run.cancel(bypass)",
      "resolved:F:section.create(no session)",
      "M5",
      "resolved:A:draft.save",
      "receipt:B:draft.save(same session, serialized behind A):rejected",
      "M6",
      "M7",
      "M8",
      "M9",
      "resolved:B:draft.save(same session, serialized behind A)",
      "M10",
      "M11",
      "M12",
      "I1",
      "receipt:E:run.cancel(bypass):rejected",
      "event:session:command.result",
      "after-macrotask",
    ]
  `);
});

it("traces an async-accepted command, its job start and completion order", async () => {
  const login = await f.login();
  const { session } = await seedSession(f, login);
  const ws = await f.connect(login);
  ws.send({ v: 1, type: "subscribe", streamId: `session:${session.id}` });
  await ws.until((frame) => frame.includes('"type":"snapshot"'));
  const resume = f.envelope("session.resume", {}, { sessionId: session.id });
  const submit = f.envelope(
    "run.submit",
    { mode: "prompt", text: "hello", attachmentIds: [] },
    { sessionId: session.id },
  );
  watchStore(
    new Map([
      [resume.id, "resume"],
      [submit.id, "submit"],
    ]),
  );
  const completed = (id: string) =>
    ws.until(
      (frame) =>
        frame.includes('"type":"command.result"') && frame.includes(id),
    );
  trace.push("call resume");
  const accepted = await f.host.execute(resume as any, "trace-client");
  trace.push(`resume resolved:${accepted.status}`);
  sentinels(6);
  await completed(resume.id);
  trace.push("resume completion frame");
  await new Promise<void>((resolve) =>
    f.host.children.size ? resolve() : setImmediate(resolve),
  );
  trace.push("call submit");
  const second = f.host.execute(submit as any, "trace-client");
  trace.push("submit called");
  sentinels(6);
  trace.push(`submit resolved:${(await second).status}`);
  await completed(submit.id);
  await ws.until((frame) => frame.includes('"outcome":"completed"'));
  trace.push("run finished frame");
  expect(trace).toMatchInlineSnapshot(`
    [
      "call resume",
      "resume resolved:accepted",
      "M1",
      "M2",
      "M3",
      "M4",
      "M5",
      "M6",
      "I1",
      "event:session:session.state",
      "event:catalog:catalog.sessionPhase",
      "put:session",
      "put:session",
      "event:session:session.state",
      "event:catalog:catalog.sessionPhase",
      "receipt:resume:completed",
      "event:session:command.result",
      "resume completion frame",
      "call submit",
      "submit called",
      "M1",
      "patch:session",
      "put:session",
      "event:catalog:catalog.session",
      "M2",
      "M3",
      "M4",
      "M5",
      "submit resolved:accepted",
      "M6",
      "I1",
      "receipt:submit:completed",
      "event:session:command.result",
      "event:session:run.state",
      "event:catalog:catalog.sessionPhase",
      "event:session:message.upsert",
      "event:session:message.upsert",
      "event:session:message.upsert",
      "event:catalog:catalog.sessionActivity",
      "event:session:run.state",
      "event:catalog:catalog.sessionPhase",
      "run finished frame",
    ]
  `);
});

it("traces WebSocket registration and fan-out order by server-side send order", async () => {
  const login = await f.login();
  await seedSession(f, login);
  const sends: string[] = [];
  const names = new Map<number, string>();
  const original = WebSocket.prototype.send;
  vi.spyOn(WebSocket.prototype, "send").mockImplementation(function (
    this: any,
    ...args: any[]
  ) {
    const label = names.get(this._socket?.remotePort);
    if (label)
      sends.push(`${label}:${String(args[0]).match(/"type":"([^"]+)"/)?.[1]}`);
    return (original as any).apply(this, args);
  } as any);
  const clients = [];
  for (const name of ["ws0", "ws1", "ws2"]) {
    const client = await f.connect(login);
    names.set((client.socket as any)._socket.localPort, name);
    clients.push(client);
  }
  trace.push("connected ws0,ws1,ws2 in order");
  // Subscribe in a different order than registration.
  for (const index of [2, 0, 1]) {
    clients[index].send({ v: 1, type: "subscribe", streamId: "catalog" });
    await clients[index].until((frame) => frame.includes('"type":"snapshot"'));
  }
  trace.push(`snapshot sends ${sends.join(",")}`);
  sends.length = 0;
  f.host.publish("catalog", "catalog.section", { id: "x", label: "fan-out" });
  trace.push(`publish sends ${sends.join(",")}`);
  sends.length = 0;
  clients[0].socket.close();
  await clients[0].closed;
  await nextMacrotask();
  f.host.publish("catalog", "catalog.section", {
    id: "y",
    label: "after close",
  });
  trace.push(`publish after ws0 closed ${sends.join(",")}`);
  expect(trace).toMatchInlineSnapshot(`
    [
      "connected ws0,ws1,ws2 in order",
      "snapshot sends ws2:snapshot,ws0:snapshot,ws1:snapshot",
      "publish sends ws0:catalog.section,ws1:catalog.section,ws2:catalog.section",
      "publish after ws0 closed ws1:catalog.section,ws2:catalog.section",
    ]
  `);
});

it("traces shutdown stage order through observable seams", async () => {
  const login = await f.login();
  const { cmd, session } = await seedSession(f, login);
  const ws = await f.connect(login);
  ws.send({ v: 1, type: "subscribe", streamId: `session:${session.id}` });
  await ws.until((frame) => frame.includes('"type":"snapshot"'));
  await cmd("session.resume", {}, { sessionId: session.id });
  await ws.until((frame) => frame.includes('"type":"command.result"'));
  const child = f.host.children.get(session.id)!;
  const accepted = await cmd(
    "run.submit",
    { mode: "prompt", text: "REJECT_DELAY", attachmentIds: [] },
    { sessionId: session.id },
  );
  trace.push(`accepted:${accepted.status}`);
  watchStore();
  const spy = (target: any, name: string, label: string) => {
    const original = target[name];
    vi.spyOn(target, name).mockImplementation(function (
      this: unknown,
      ...args: any[]
    ) {
      trace.push(label);
      return original.apply(this, args);
    });
  };
  spy(WebSocket.prototype, "terminate", "ws.terminate");
  spy(child, "closeAndWait", "child.closeAndWait");
  spy(f.host.resources, "closeAndWait", "resources.closeAndWait");
  spy(f.host.store, "close", "store.close");
  const closing = f.host.close();
  trace.push("close() returned a promise");
  let stage = "";
  do {
    stage = JSON.parse(await f.controlRaw('{"type":"health"}\n')).shutdownStage;
  } while (stage !== "drain");
  trace.push(`health stage:${stage}`);
  await closing;
  trace.push("close resolved");
  trace.push(
    `control after close:${await f.controlRaw('{"type":"health"}\n').then(
      () => "answered",
      (e) => e.code,
    )}`,
  );
  expect(trace).toMatchInlineSnapshot(`
    [
      "accepted:accepted",
      "ws.terminate",
      "close() returned a promise",
      "health stage:drain",
      "receipt:00000000-0000-4000-8000-000000000021:rejected",
      "event:session:command.result",
      "child.closeAndWait",
      "resources.closeAndWait",
      "store.close",
      "close resolved",
      "control after close:ENOENT",
    ]
  `);
});
