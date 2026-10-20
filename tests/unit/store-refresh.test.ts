import { createHash } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { snapshotFrames } from "../../apps/host/src/framing.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

async function connectedStore() {
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
  vi.stubGlobal("window", {});
  vi.stubGlobal("localStorage", {
    getItem: () => null,
    setItem: () => undefined,
    removeItem: () => undefined,
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
    querySelector: () => null,
  });
  vi.stubGlobal("WebSocket", FakeWebSocket);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.push(callback);
    return frames.length;
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string) =>
      input === "/v1/client"
        ? { ok: true, json: async () => ({ csrf: "csrf", clientId: "client" }) }
        : {
            json: async () => ({
              status: "completed",
              result: { sessions: [] },
            }),
          },
    ),
  );
  const api = await import("../../apps/web/src/store.js");
  await api.connect();
  return {
    ...api,
    socket: FakeWebSocket.sockets.at(-1)!,
    sockets: FakeWebSocket.sockets,
    frames,
  };
}

it("ignores completed assembly and reset callbacks from an obsolete socket", async () => {
  const digestResolvers: ((value: ArrayBuffer) => void)[] = [];
  vi.stubGlobal("crypto", {
    subtle: {
      digest: vi.fn(
        () =>
          new Promise<ArrayBuffer>((resolve) => digestResolvers.push(resolve)),
      ),
    },
  });
  const context = await connectedStore();
  const first = context.socket;
  const stalePayload = {
    seq: 7,
    messages: [{ messageId: "stale-E1", text: "x".repeat(600_000) }],
  };
  const staleFrames = snapshotFrames("session:stale", 7, "E1", stalePayload);
  const resetPayload = { seq: 8, text: "y".repeat(600_000) };
  const resetFrames = snapshotFrames("session:reset", 8, "E1", resetPayload);
  resetFrames[0].sha256 = "0".repeat(64);
  for (const frame of [...staleFrames, ...resetFrames]) first.emit(frame);
  expect(digestResolvers).toHaveLength(2);

  first.close();
  await context.connect();
  const current = context.sockets.at(-1)!;
  current.emit({
    type: "snapshot",
    streamId: "catalog",
    hostEpoch: "E2",
    payload: { sessions: [{ id: "current" }] },
  });
  current.emit({
    type: "snapshot",
    streamId: "session:current",
    hostEpoch: "E2",
    payload: { seq: 12, messages: [{ messageId: "current-E2" }] },
  });
  context.frames.shift()?.(0);
  const sentBeforeRelease = [...current.sent];

  const staleBytes = Buffer.from(JSON.stringify(stalePayload));
  const resetBytes = Buffer.from(JSON.stringify(resetPayload));
  digestResolvers[0](
    Uint8Array.from(createHash("sha256").update(staleBytes).digest()).buffer,
  );
  digestResolvers[1](
    Uint8Array.from(createHash("sha256").update(resetBytes).digest()).buffer,
  );
  await new Promise((resolve) => setTimeout(resolve, 0));

  expect(context.store.getSnapshot()).toMatchObject({
    hostEpoch: "E2",
    catalog: { sessions: [{ id: "current" }] },
    projections: {
      current: { seq: 12, messages: [{ messageId: "current-E2" }] },
    },
  });
  expect(context.store.getSnapshot().projections.stale).toBeUndefined();
  expect(current.sent).toEqual(sentBeforeRelease);
  expect(current.sent).not.toContainEqual(
    expect.objectContaining({ streamId: "session:reset" }),
  );
});

it("does not relabel a background cached projection after a catalog epoch change", async () => {
  const context = await connectedStore();
  const { socket, select } = context;
  socket.emit({
    type: "snapshot",
    streamId: "catalog",
    hostEpoch: "E1",
    payload: { sessions: [] },
  });
  socket.emit({
    type: "snapshot",
    streamId: "session:background",
    hostEpoch: "E1",
    payload: { seq: 42 },
  });
  context.frames.shift()?.(0);
  socket.emit({
    type: "snapshot",
    streamId: "catalog",
    hostEpoch: "E2",
    payload: { sessions: [] },
  });

  select("background");
  expect(socket.sent.at(-1)).toEqual({
    v: 1,
    type: "subscribe",
    streamId: "session:background",
  });
});

it("drops an old-epoch projection queued before the animation frame", async () => {
  const context = await connectedStore();
  const { socket, select, store } = context;
  socket.emit({
    type: "snapshot",
    streamId: "catalog",
    hostEpoch: "E1",
    payload: { sessions: [] },
  });
  socket.emit({
    type: "snapshot",
    streamId: "session:queued",
    hostEpoch: "E1",
    payload: { seq: 17 },
  });
  socket.emit({
    type: "snapshot",
    streamId: "catalog",
    hostEpoch: "E2",
    payload: { sessions: [] },
  });
  context.frames.shift()?.(0);

  select("queued");
  expect(store.getSnapshot().projections.queued).toBeUndefined();
  expect(socket.sent.at(-1)).toEqual({
    v: 1,
    type: "subscribe",
    streamId: "session:queued",
  });
});

it("resumes a projection received through the socket within the same epoch", async () => {
  const context = await connectedStore();
  const { socket, select } = context;
  socket.emit({
    type: "snapshot",
    streamId: "catalog",
    hostEpoch: "E1",
    payload: { sessions: [] },
  });
  socket.emit({
    type: "snapshot",
    streamId: "session:cached",
    hostEpoch: "E1",
    payload: { seq: 42 },
  });
  context.frames.shift()?.(0);

  select("cached");
  expect(socket.sent.at(-1)).toEqual({
    v: 1,
    type: "subscribe",
    streamId: "session:cached",
    afterSeq: 42,
    hostEpoch: "E1",
  });
});

it("a late running catalog response cannot overwrite the newer idle catalog", async () => {
  vi.stubGlobal("window", {});
  vi.stubGlobal("localStorage", { getItem: () => null });
  const pending: ((response: any) => void)[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(() => new Promise((resolve) => pending.push(resolve))),
  );
  const { refresh, store } = await import("../../apps/web/src/store.js");
  store.getSnapshot().ready = true;
  const first = refresh();
  const second = refresh();
  const completed = {
    projects: [],
    workspaces: [],
    sessions: [{ id: "background", phase: "idle" }],
    runtimes: [],
  };
  pending[1]({
    json: async () => ({ status: "completed", result: completed }),
  });
  await second;
  pending[0]({
    json: async () => ({
      status: "completed",
      result: {
        ...completed,
        sessions: [{ id: "background", phase: "running" }],
      },
    }),
  });
  await first;
  expect(store.getSnapshot().catalog).toEqual(completed);
  expect(store.getSnapshot().error).toBeUndefined();
});

it("ignores an obsolete refresh failure after a successful newer refresh", async () => {
  vi.stubGlobal("window", {});
  vi.stubGlobal("localStorage", { getItem: () => null });
  const pending: {
    resolve: (response: any) => void;
    reject: (error: Error) => void;
  }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(
      () => new Promise((resolve, reject) => pending.push({ resolve, reject })),
    ),
  );
  const { refresh, store } = await import("../../apps/web/src/store.js");
  store.getSnapshot().ready = true;
  const first = refresh();
  const second = refresh();
  pending[1].resolve({
    json: async () => ({ status: "completed", result: { sessions: [] } }),
  });
  await second;
  pending[0].reject(Error("Obsolete network error"));
  await first;
  expect(store.getSnapshot().error).toBeUndefined();
});
