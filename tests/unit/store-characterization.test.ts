import { afterEach, expect, it, vi } from "vitest";

// Characterization of store behaviour that the store/ split (F3l) touches:
// pending command resolution, early results, outbox recovery, reconnect and
// resubscribe, draft ordering, uploads, catalog readiness, native reauth.

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.resetModules();
});

type Fetch = (input: string, init?: any) => Promise<any> | any;

async function setup(
  options: {
    window?: Record<string, any>;
    selectedKey?: string;
    fetchImpl?: Fetch;
  } = {},
) {
  const frames: FrameRequestCallback[] = [];
  class FakeWebSocket {
    static OPEN = 1;
    static CONNECTING = 0;
    static sockets: FakeWebSocket[] = [];
    readyState = FakeWebSocket.OPEN;
    constructor() {
      FakeWebSocket.sockets.push(this);
    }
    sent: any[] = [];
    onopen?: () => void;
    onclose?: () => void;
    onmessage?: (event: { data: string }) => void;
    send(data: string) {
      this.sent.push(JSON.parse(data));
    }
    emit(event: any) {
      this.onmessage?.({ data: JSON.stringify(event) });
    }
    close() {
      this.readyState = 3;
      this.onclose?.();
    }
  }
  const storage = new Map<string, string>();
  const dispatched: any[] = [];
  const win: Record<string, any> = {
    dispatchEvent: (event: any) => dispatched.push(event),
    addEventListener: () => undefined,
    ...options.window,
  };
  vi.stubGlobal("window", win);
  vi.stubGlobal("localStorage", {
    get length() {
      return storage.size;
    },
    key: (index: number) => [...storage.keys()][index] ?? null,
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => void storage.set(key, value),
    removeItem: (key: string) => void storage.delete(key),
  });
  vi.stubGlobal("location", {
    href: "http://localhost/",
    protocol: "http:",
    host: "localhost",
    pathname: "/",
    search: "",
    hash: "",
  });
  vi.stubGlobal("history", { replaceState: () => undefined });
  vi.stubGlobal("document", {
    documentElement: { dataset: {} },
    querySelector: (selector: string) => (selector === ".shell" ? {} : null),
  });
  vi.stubGlobal("WebSocket", FakeWebSocket);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.push(callback);
    return frames.length;
  });
  const calls: { input: string; init?: any; body?: any }[] = [];
  const ctx = {
    fetchImpl: options.fetchImpl as Fetch | undefined,
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init?: any) => {
      calls.push({
        input,
        init,
        body:
          typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      });
      const custom = ctx.fetchImpl
        ? await ctx.fetchImpl(input, init)
        : undefined;
      if (custom) return custom;
      if (input === "/v1/client")
        return {
          ok: true,
          json: async () => ({ csrf: "tok", clientId: "client" }),
        };
      return {
        ok: true,
        json: async () => ({ status: "completed", result: { sessions: [] } }),
      };
    }),
  );
  const api = await import("../../apps/web/src/store.js");
  await api.connect();
  const socket = FakeWebSocket.sockets.at(-1)!;
  return {
    ...api,
    socket,
    sockets: FakeWebSocket.sockets,
    frames,
    storage,
    dispatched,
    calls,
    ctx,
    win,
  };
}

const settle = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};
const commandCalls = (calls: { input: string; init?: any; body?: any }[]) =>
  calls.filter(
    (c) => c.input === "/v1/commands" && c.body.type !== "catalog.get",
  );

it("resolves an accepted command from a later command.result event", async () => {
  const context = await setup({
    fetchImpl: (input, init) =>
      input === "/v1/commands" && JSON.parse(init.body).type === "thing.do"
        ? { json: async () => ({ status: "accepted" }) }
        : undefined,
  });
  const done = context.command("thing.do", { a: 1 });
  await settle();
  const sent = commandCalls(context.calls)[0];
  expect(sent.init.headers["X-Suri-Csrf"]).toBe("tok");
  expect(sent.body).toMatchObject({
    v: 1,
    type: "thing.do",
    payload: { a: 1 },
  });
  context.socket.emit({
    type: "command.result",
    payload: { id: sent.body.id, status: "completed", result: { ok: 1 } },
  });
  await expect(done).resolves.toEqual({ ok: 1 });
});

it("uses a command.result that arrives before the receipt (earlyResults)", async () => {
  const holder: { context?: Awaited<ReturnType<typeof setup>> } = {};
  const context = await setup({
    fetchImpl: (input, init) => {
      if (input !== "/v1/commands") return undefined;
      const body = JSON.parse(init.body);
      if (body.type === "early.ok" || body.type === "early.bad") {
        holder.context!.socket.emit({
          type: "command.result",
          payload:
            body.type === "early.ok"
              ? { id: body.id, status: "completed", result: { early: true } }
              : {
                  id: body.id,
                  status: "rejected",
                  error: { message: "no thanks" },
                },
        });
        return { json: async () => ({ status: "accepted" }) };
      }
      return undefined;
    },
  });
  holder.context = context;
  await expect(context.command("early.ok")).resolves.toEqual({ early: true });
  await expect(context.command("early.bad")).rejects.toThrow("no thanks");
  expect(context.store.getSnapshot().error).toBe("no thanks");
});

it("rejects a rejected receipt and requires readiness before sending", async () => {
  const context = await setup({
    fetchImpl: (input, init) =>
      input === "/v1/commands" && JSON.parse(init.body).type === "nope"
        ? {
            json: async () => ({
              status: "rejected",
              error: { message: "bad" },
            }),
          }
        : undefined,
  });
  await expect(context.command("nope")).rejects.toThrow("bad");
  context.store.getSnapshot().ready = false;
  const before = context.calls.length;
  await expect(context.command("anything")).rejects.toThrow(
    "Connection is not ready.",
  );
  expect(context.calls.length).toBe(before);
});

it("keeps a run.submit outbox entry until completed and restores the draft when rejected", async () => {
  const context = await setup({
    fetchImpl: (input, init) =>
      input === "/v1/commands" && JSON.parse(init.body).type === "run.submit"
        ? { json: async () => ({ status: "accepted" }) }
        : undefined,
  });
  context.storage.set("suri.draft.s1", "typed later");
  context.storage.set(
    "suri.attachments.s1",
    JSON.stringify([{ id: "b", name: "b" }]),
  );
  const first = await context.command(
    "run.submit",
    { text: "hello", attachmentIds: ["a"] },
    "s1",
  );
  const submits = commandCalls(context.calls).filter(
    (c) => c.body.type === "run.submit",
  );
  const id = submits[0].body.id;
  expect(first).toEqual({ accepted: true, requestId: id });
  expect(JSON.parse(context.storage.get(`suri.outbox.${id}`)!)).toMatchObject({
    id,
    sessionId: "s1",
    text: "hello",
    attachmentIds: ["a"],
    attachments: [{ id: "b", name: "b" }],
  });
  // command() subscribes the session stream before sending.
  expect(context.socket.sent).toContainEqual(
    expect.objectContaining({ type: "subscribe", streamId: "session:s1" }),
  );

  context.storage.set(
    "suri.attachments.s1",
    JSON.stringify([{ id: "c", name: "c" }]),
  );
  context.socket.emit({
    type: "command.result",
    payload: { id, status: "rejected", error: { message: "denied" } },
  });
  expect(context.storage.has(`suri.outbox.${id}`)).toBe(false);
  expect(context.storage.get("suri.draft.s1")).toBe("hello\n\ntyped later");
  expect(
    JSON.parse(context.storage.get("suri.attachments.s1")!).map(
      (a: any) => a.id,
    ),
  ).toEqual(["b", "c"]);
  expect(context.dispatched.at(-1)).toMatchObject({
    type: "suri-draft-restored",
    detail: { sessionId: "s1" },
  });
  expect(context.store.getSnapshot().error).toBe("denied");

  await context.command(
    "run.submit",
    { text: "again", attachmentIds: [] },
    "s1",
  );
  const id2 = commandCalls(context.calls).filter(
    (c) => c.body.type === "run.submit",
  )[1].body.id;
  expect(context.storage.has(`suri.outbox.${id2}`)).toBe(true);
  context.socket.emit({
    type: "command.result",
    payload: { id: id2, status: "completed" },
  });
  expect(context.storage.has(`suri.outbox.${id2}`)).toBe(false);
});

it("reconnects after close with backoff and resubscribes catalog and the active stream", async () => {
  const context = await setup();
  const first = context.socket;
  first.emit({
    type: "snapshot",
    streamId: "catalog",
    hostEpoch: "E1",
    payload: { sessions: [{ id: "s1" }] },
  });
  first.emit({
    type: "snapshot",
    streamId: "session:s1",
    hostEpoch: "E1",
    payload: { seq: 42 },
  });
  context.frames.shift()?.(0);
  context.select("s1");
  first.onopen?.();
  expect(context.store.getSnapshot().connected).toBe(true);

  vi.useFakeTimers({ toFake: ["setTimeout"] });
  first.close();
  expect(context.store.getSnapshot().connected).toBe(false);
  await settle();
  expect(context.sockets).toHaveLength(1);
  vi.advanceTimersByTime(400);
  expect(context.sockets).toHaveLength(2);
  const second = context.sockets.at(-1)!;
  second.onopen?.();
  expect(context.store.getSnapshot().connected).toBe(true);
  expect(second.sent).toEqual([
    { v: 1, type: "subscribe", streamId: "catalog" },
    {
      v: 1,
      type: "subscribe",
      streamId: "session:s1",
      afterSeq: 42,
      hostEpoch: "E1",
    },
  ]);
  // The obsolete socket is ignored.
  first.emit({
    type: "snapshot",
    streamId: "catalog",
    hostEpoch: "E9",
    payload: { sessions: [] },
  });
  expect(context.store.getSnapshot().hostEpoch).toBe("E1");

  // Backoff grows while the host stays unreachable.
  context.ctx.fetchImpl = (input) =>
    input === "/v1/client" ? Promise.reject(Error("offline")) : undefined;
  second.close();
  await settle();
  vi.advanceTimersByTime(200);
  expect(context.sockets).toHaveLength(2);
  vi.advanceTimersByTime(200);
  expect(context.sockets).toHaveLength(3);
  context.sockets.at(-1)!.close();
  await settle();
  vi.advanceTimersByTime(400);
  expect(context.sockets).toHaveLength(3);
  vi.advanceTimersByTime(250);
  expect(context.sockets).toHaveLength(4);
});

it("a gap in a session stream resubscribes, a contiguous event is reduced", async () => {
  const context = await setup();
  const { socket } = context;
  socket.emit({
    type: "snapshot",
    streamId: "catalog",
    hostEpoch: "E1",
    payload: { sessions: [] },
  });
  socket.emit({
    type: "snapshot",
    streamId: "session:g",
    hostEpoch: "E1",
    payload: { seq: 5 },
  });
  const sentBefore = socket.sent.length;
  socket.emit({
    type: "run.state",
    streamId: "session:g",
    sessionId: "g",
    seq: 9,
    payload: {},
  });
  expect(socket.sent.slice(sentBefore)).toEqual([
    {
      v: 1,
      type: "subscribe",
      streamId: "session:g",
      afterSeq: 5,
      hostEpoch: "E1",
    },
  ]);
});

it("orders draft.save writes per session and tracks draft revisions", async () => {
  let release: (() => void) | undefined;
  const context = await setup({
    window: { suriUpdate: { client: "c1" } },
    fetchImpl: (input, init) => {
      if (input !== "/v1/commands") return undefined;
      const body = JSON.parse(init.body);
      if (body.type !== "draft.save") return undefined;
      const result = {
        json: async () => ({
          status: "completed",
          result: { revision: body.payload.n },
        }),
      };
      if (body.payload.n !== 3) return result;
      return new Promise((resolve) => {
        release = () => resolve(result);
      });
    },
  });
  expect(context.viewDraftRevision("s1")).toBe(0);
  const a = context.command("draft.save", { n: 3 }, "s1", 99);
  const b = context.command("draft.save", { n: 4 }, "s1", 99);
  await settle();
  const saves = () =>
    context.calls
      .filter((c) => c.body?.type === "draft.save")
      .map((c) => c.body);
  expect(saves()).toHaveLength(1);
  release!();
  await a;
  expect(context.viewDraftRevision("s1")).toBe(3);
  await b;
  expect(saves()).toHaveLength(2);
  // Revision chaining overrides the caller's expectedRevision and tags the client.
  expect(saves()[0]).toMatchObject({
    payload: { clientInstanceId: "c1" },
  });
  expect(saves()[1]).toMatchObject({
    expectedRevision: 3,
    payload: { clientInstanceId: "c1" },
  });
  expect(context.viewDraftRevision("s1")).toBe(4);
  // Revisions never go backwards.
  await context.command("draft.save", { n: 2 }, "s1");
  expect(context.viewDraftRevision("s1")).toBe(4);
});

it("restores a draft once per sequence and raises the draft revision", async () => {
  const context = await setup();
  const event = {
    type: "draft.restored",
    streamId: "session:s2",
    seq: 4,
    payload: {
      clientId: "client",
      revision: 6,
      text: "from host",
      attachments: [{ id: "x", name: "x" }],
    },
  };
  context.storage.set("suri.draft.s2", "local");
  context.socket.emit(event);
  expect(context.viewDraftRevision("s2")).toBe(6);
  expect(context.storage.get("suri.draft.s2")).toBe("local\n\nfrom host");
  expect(context.storage.get("suri.restored.s2")).toBe("4");
  expect(context.dispatched).toHaveLength(1);
  context.socket.emit(event);
  expect(context.storage.get("suri.draft.s2")).toBe("local\n\nfrom host");
  expect(context.dispatched).toHaveLength(1);
  context.socket.emit({
    ...event,
    seq: 5,
    payload: { ...event.payload, clientId: "someone-else", text: "other" },
  });
  expect(context.storage.get("suri.draft.s2")).toBe("local\n\nfrom host");
});

it("uploads attachments with csrf headers, counts pending uploads and surfaces errors", async () => {
  let observed = -1;
  const context = await setup();
  context.ctx.fetchImpl = (input, init) => {
    if (input === "/v1/attachments") {
      observed = context.win.suriUploadsPending;
      return init.headers["X-Suri-Name"] === "bad%20name.txt"
        ? { ok: false, json: async () => ({ error: { message: "too big" } }) }
        : { ok: true, json: async () => ({ id: "att1" }) };
    }
    if (input === "/v1/import-files")
      return { ok: true, json: async () => ({ imported: 1 }) };
    return undefined;
  };
  const file = { name: "a b.png", type: "image/png", size: 3 } as File;
  await expect(context.upload(file, "s1", "image")).resolves.toEqual({
    id: "att1",
  });
  const sent = context.calls.find((c) => c.input === "/v1/attachments")!;
  expect(sent.init).toMatchObject({
    method: "POST",
    body: file,
    headers: {
      "X-Suri-Csrf": "tok",
      "Content-Type": "image/png",
      "X-Suri-Name": "a%20b.png",
      "X-Suri-Kind": "image",
      "X-Suri-Session": "s1",
    },
  });
  expect(observed).toBe(1);
  expect(context.win.suriUploadsPending).toBe(0);
  await expect(
    context.upload({ name: "bad name.txt", type: "", size: 1 } as File, "s1"),
  ).rejects.toThrow("too big");
  expect(context.win.suriUploadsPending).toBe(0);

  await expect(
    context.uploadHistory({ name: "h.jsonl", size: 33 * 1048576 } as File),
  ).rejects.toThrow("History exceeds 32 MiB.");
  expect(context.calls.some((c) => c.input === "/v1/import-files")).toBe(false);
  const history = { name: "h x.jsonl", size: 10 } as File;
  await expect(context.uploadHistory(history)).resolves.toEqual({
    imported: 1,
  });
  expect(
    context.calls.find((c) => c.input === "/v1/import-files")!.init,
  ).toMatchObject({
    headers: {
      "X-Suri-Csrf": "tok",
      "X-Suri-Name": "h%20x.jsonl",
      "Content-Type": "application/octet-stream",
    },
  });
});

it("reports suriReady only after socket, catalog and the selected projection are present", async () => {
  const context = await setup();
  const ready = () => (context.win as any).suriReady as boolean;
  expect(ready()).toBe(false);
  context.socket.onopen?.();
  expect(ready()).toBe(false);
  context.socket.emit({
    type: "snapshot",
    streamId: "catalog",
    hostEpoch: "E1",
    payload: { sessions: [{ id: "s1" }] },
  });
  expect(ready()).toBe(true);
  context.select("s1");
  expect(ready()).toBe(false);
  context.socket.emit({
    type: "snapshot",
    streamId: "session:s1",
    hostEpoch: "E1",
    payload: { seq: 1 },
  });
  context.frames.shift()?.(0);
  expect(ready()).toBe(true);
});

it("selection persists, updates the url, and switching unsubscribes the previous stream", async () => {
  const context = await setup();
  const replace = vi.fn();
  vi.stubGlobal("history", { replaceState: replace });
  context.select("one");
  context.select("two");
  expect(context.storage.get("suri.selected")).toBe("two");
  expect(replace).toHaveBeenLastCalledWith(null, "", "/?session=two");
  expect(context.socket.sent).toEqual([
    { v: 1, type: "subscribe", streamId: "session:one" },
    { v: 1, type: "unsubscribe", streamId: "session:one" },
    { v: 1, type: "subscribe", streamId: "session:two" },
  ]);
  context.select();
  expect(context.storage.has("suri.selected")).toBe(false);
  expect(context.store.getSnapshot().selected).toBeUndefined();
});

it("a catalog snapshot supersedes an in-flight refresh and drops a vanished selection", async () => {
  const context = await setup();
  context.select("gone");
  const pendingFetch: ((value: any) => void)[] = [];
  context.ctx.fetchImpl = (input) =>
    input === "/v1/commands"
      ? new Promise((resolve) => pendingFetch.push(resolve))
      : undefined;
  const refreshing = context.refresh();
  await settle();
  context.socket.emit({
    type: "snapshot",
    streamId: "catalog",
    hostEpoch: "E1",
    payload: {
      projects: [],
      workspaces: [],
      sessions: [{ id: "keep" }],
      runtimes: [],
    },
  });
  pendingFetch[0]({
    json: async () => ({
      status: "completed",
      result: { sessions: [{ id: "stale" }] },
    }),
  });
  await refreshing;
  expect(context.store.getSnapshot().catalog.sessions).toEqual([
    { id: "keep" },
  ]);

  context.ctx.fetchImpl = undefined;
  await context.refresh();
  expect(context.store.getSnapshot().catalog.sessions).toEqual([]);
  expect(context.store.getSnapshot().selected).toBeUndefined();
});

it("requests native reauthentication at most once across commands, uploads and connect", async () => {
  const postMessage = vi.fn();
  const context = await setup({
    window: { webkit: { messageHandlers: { suri: { postMessage } } } },
  });
  context.ctx.fetchImpl = (input) =>
    input === "/v1/client" ? { ok: false, status: 401 } : { status: 401 };
  context.report(Error("old"));
  let settled = false;
  void context.command("x.y").finally(() => (settled = true));
  await settle();
  expect(postMessage).toHaveBeenCalledTimes(1);
  expect(postMessage).toHaveBeenCalledWith({ type: "reauthenticate" });
  expect(context.store.getSnapshot().error).toBeUndefined();
  void context
    .upload({ name: "f", type: "", size: 1 } as File, "s1")
    .finally(() => (settled = true));
  void context
    .uploadHistory({ name: "f", size: 1 } as File)
    .finally(() => (settled = true));
  await context.connect();
  await settle();
  expect(postMessage).toHaveBeenCalledTimes(1);
  expect(settled).toBe(false);
});

it("connect without a bridge reports the open-from-native-app error", async () => {
  const context = await setup();
  context.ctx.fetchImpl = (input) =>
    input === "/v1/client" ? { ok: false, status: 401 } : undefined;
  await context.connect();
  expect(context.store.getSnapshot().error).toBe(
    "Open Suri Pi from the native app or run npm start.",
  );
  context.dismiss();
  expect(context.store.getSnapshot().error).toBeUndefined();
});
