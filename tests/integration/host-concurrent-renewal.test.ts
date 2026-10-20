import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import { startHost } from "../../apps/host/src/host.js";
import { control } from "../../apps/host/src/cli.js";

// Pre-move characterization of host authentication (apps/host/src/host.ts
// `auth`, /v1/bootstrap, /v1/events upgrade, control bootstrap). Only Date.now
// is spied; network timers stay real except transport socket-expiry timers
// (>= 1h), which are held and fired by `advance` against the controlled clock.
// Ordering uses barrier promises.
const EIGHT_HOURS = 8 * 3600000; // host.ts: client.expires = Date.now() + 8 * 3600000
const NONCE_TTL = 60000; // host.ts: nonces.set(..., expires: Date.now() + 60000)

let clock = 0;
let root: string;
let host: Awaited<ReturnType<typeof startHost>>;
let sockets: WebSocket[] = [];
type Held = { fn: () => void; due: number };
const held = new Map<object, Held>();
/** Fires held expiry timers that are due at the controlled clock. */
function advance(to: number) {
  clock = to;
  for (;;) {
    const due = [...held].filter(([, h]) => h.due <= clock);
    if (!due.length) return;
    for (const [handle, h] of due) {
      held.delete(handle);
      h.fn();
    }
  }
}
const closed = (s: WebSocket) =>
  new Promise<number>((resolve) => s.once("close", resolve));

beforeEach(async () => {
  const real = Date.now();
  clock = real;
  held.clear();
  vi.spyOn(Date, "now").mockImplementation(() => clock);
  const realSet = globalThis.setTimeout;
  const realClear = globalThis.clearTimeout;
  vi.spyOn(globalThis, "setTimeout").mockImplementation(((
    fn: () => void,
    ms?: number,
    ...args: unknown[]
  ) => {
    if ((ms ?? 0) < 3600000)
      return realSet(fn, ms, ...args) as unknown as NodeJS.Timeout;
    const handle = { unref: () => handle };
    held.set(handle, { fn, due: clock + (ms ?? 0) });
    return handle as unknown as NodeJS.Timeout;
  }) as typeof setTimeout);
  vi.spyOn(globalThis, "clearTimeout").mockImplementation(((
    handle?: NodeJS.Timeout,
  ) => {
    if (handle && held.delete(handle as unknown as object)) return;
    realClear(handle);
  }) as typeof clearTimeout);
  root = await mkdtemp(join(tmpdir(), "suri-renewal-"));
  host = await startHost({
    root,
    assets: resolve("dist/ui"),
    helper: resolve("dist/native/suri-helper"),
  });
});
afterEach(async () => {
  for (const socket of sockets) socket.terminate();
  sockets = [];
  await host.close();
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

type Session = { cookie: string; csrf: string; clientId: string };
const bootstrapRequest = (nonce: string) =>
  fetch(host.origin + "/v1/bootstrap", {
    method: "POST",
    headers: { Origin: host.origin, "Content-Type": "application/json" },
    body: JSON.stringify({ nonce }),
  });
async function readSession(response: Response): Promise<Session> {
  expect(response.status).toBe(200);
  const cookie = response.headers.get("set-cookie")!.split(";")[0];
  const { csrf, clientId } = (await response.json()) as {
    csrf: string;
    clientId: string;
  };
  return { cookie, csrf, clientId };
}
async function login(clientId?: string): Promise<Session> {
  const { nonce } = await control(
    root,
    clientId ? { type: "bootstrap", clientId } : { type: "bootstrap" },
  );
  return readSession(await bootstrapRequest(nonce));
}
const getClient = (s: Session) =>
  fetch(host.origin + "/v1/client", { headers: { Cookie: s.cookie } });
const command = (
  type: string,
  payload: Record<string, unknown> = {},
  extra = {},
) => ({
  v: 1 as const,
  id: randomUUID(),
  createdAt: new Date().toISOString(),
  type,
  payload,
  ...extra,
});
const post = (s: Session, body: unknown, csrf = s.csrf) =>
  fetch(host.origin + "/v1/commands", {
    method: "POST",
    headers: { Cookie: s.cookie, Origin: host.origin, "X-Suri-Csrf": csrf },
    body: JSON.stringify(body),
  });

type Upgrade =
  | {
      status: 101;
      socket: WebSocket;
      frames: any[];
      next: (p: (f: any) => boolean) => Promise<any>;
    }
  | { status: number };
/** Resolves when the upgrade is answered; real ws client, no sleeps. */
function upgrade(s: Session): Promise<Upgrade> {
  return new Promise((done) => {
    const socket = new WebSocket(
      host.origin.replace("http", "ws") + "/v1/events",
      {
        headers: { Cookie: s.cookie, Origin: host.origin },
      },
    );
    sockets.push(socket);
    const frames: any[] = [];
    const waiters: { p: (f: any) => boolean; resolve: (f: any) => void }[] = [];
    socket.on("message", (bytes) => {
      const frame = JSON.parse(bytes.toString());
      frames.push(frame);
      for (const w of [...waiters])
        if (w.p(frame)) {
          waiters.splice(waiters.indexOf(w), 1);
          w.resolve(frame);
        }
    });
    socket.on("open", () =>
      done({
        status: 101,
        socket,
        frames,
        next: (p) =>
          new Promise((resolve) => {
            const seen = frames.find(p);
            if (seen) resolve(seen);
            else waiters.push({ p, resolve });
          }),
      }),
    );
    socket.on("unexpected-response", (_req, res) => {
      done({ status: res.statusCode ?? 0 });
      socket.terminate();
    });
    socket.on("error", () => {});
  });
}
const open = async (s: Session) => {
  const u = await upgrade(s);
  expect(u.status).toBe(101);
  return u as Extract<Upgrade, { status: 101 }>;
};
function seedSession() {
  const project = { id: randomUUID(), root, label: "fixture", revision: 1 };
  const workspace = {
    id: randomUUID(),
    projectId: project.id,
    root,
    label: "fixture",
    revision: 1,
  };
  const runtime = {
    id: randomUUID(),
    version: "fixture",
    executable: "/fixture",
    identity: "fixture",
    status: "candidate",
    revision: 1,
  };
  host.store.put("project", project);
  host.store.put("workspace", workspace);
  host.store.put("runtime", runtime);
  const session = {
    id: randomUUID(),
    workspaceId: workspace.id,
    runtimeId: runtime.id,
    name: "fixture",
    revision: 1,
  };
  host.store.put("session", session);
  return session;
}
const draftSave = (sessionId: string, text: string) =>
  command(
    "draft.save",
    { text, attachmentIds: [] },
    { sessionId, expectedRevision: 0 },
  );

it("renews A concurrently via GET and upgrade while unrenewed B expires; open B socket keeps streaming", async () => {
  const t0 = clock;
  const session = seedSession();
  const a = await login();
  const b = await login();
  expect(a.clientId).not.toBe(b.clientId);
  expect(a.cookie).not.toBe(b.cookie);
  const aSocket = await open(a);
  const bSocket = await open(b);
  for (const client of [aSocket, bSocket])
    for (const streamId of [`session:${session.id}`, "catalog"]) {
      client.socket.send(JSON.stringify({ v: 1, type: "subscribe", streamId }));
      await client.next(
        (f) => f.type === "snapshot" && f.streamId === streamId,
      );
    }

  // Just before eight hours: A's GET and a new A upgrade race (barrier: both
  // are started before either is awaited).
  clock = t0 + EIGHT_HOURS - 1;
  const [renewedGet, renewedUpgrade] = await Promise.all([
    getClient(a),
    upgrade(a),
  ]);
  expect(renewedGet.status).toBe(200);
  expect(renewedGet.headers.get("set-cookie")).toBe(
    `${a.cookie}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800`,
  );
  expect(await renewedGet.json()).toEqual({
    csrf: a.csrf,
    clientId: a.clientId,
  });
  expect(renewedUpgrade.status).toBe(101);

  // Past B's original expiry; A (renewed to t0+16h-1) survives, B does not.
  const bClose = closed(bSocket.socket);
  advance(t0 + EIGHT_HOURS + 1);
  const aAfter = await getClient(a);
  expect(aAfter.status).toBe(200);
  expect(await aAfter.json()).toEqual({ csrf: a.csrf, clientId: a.clientId });
  const accepted = await post(a, draftSave(session.id, "from A"));
  expect(accepted.status).toBe(200);
  expect(((await accepted.json()) as any).status).toBe("completed");
  expect((await open(a)).status).toBe(101);

  expect((await getClient(b)).status).toBe(401);
  expect((await upgrade(b)).status).toBe(401);
  const draftsBefore = host.store.list("draft").length;
  const stale = await post(b, draftSave(session.id, "from B"));
  expect(stale.status).toBe(401);
  expect(host.store.list("draft").length).toBe(draftsBefore);
  expect(host.store.get("draft", `${session.id}:${a.clientId}`)).toMatchObject({
    text: "from A",
  });
  expect(() =>
    host.store.get("draft", `${session.id}:${b.clientId}`),
  ).toThrow();

  // The expiry timer closed B's open socket with 1008; A keeps streaming and
  // B receives no later catalog frame.
  expect(await bClose).toBe(1008);
  const aEvent = aSocket.next((f) => f.type === "catalog.section");
  const section = await post(
    a,
    command("section.create", { label: "after expiry" }),
  );
  expect(((await section.json()) as any).status).toBe("completed");
  expect(await aEvent).toMatchObject({
    type: "catalog.section",
    payload: { label: "after expiry" },
  });
  expect(bSocket.frames.some((f) => f.type === "catalog.section")).toBe(false);
  expect(aSocket.socket.readyState).toBe(WebSocket.OPEN);
});

it("failed CSRF cannot renew a cookie or its expiry", async () => {
  const t0 = clock;
  const [a, b, c, d] = [
    await login(),
    await login(),
    await login(),
    await login(),
  ];
  advance(t0 + EIGHT_HOURS - 1000);
  const url = host.origin + "/v1/nope";
  const bad: Array<Promise<Response>> = [
    post(a, command("catalog.get"), "wrong"),
    post(a, command("catalog.get"), b.csrf),
    fetch(host.origin + "/v1/commands", {
      method: "POST",
      headers: { Cookie: a.cookie, Origin: host.origin },
      body: JSON.stringify(command("catalog.get")),
    }),
    fetch(host.origin + "/v1/commands", {
      method: "POST",
      headers: { Cookie: a.cookie, "X-Suri-Csrf": a.csrf },
      body: JSON.stringify(command("catalog.get")),
    }),
    fetch(url, { headers: { Cookie: a.cookie } }),
    fetch(url, {
      method: "POST",
      headers: { Cookie: a.cookie, Origin: host.origin },
    }),
  ];
  for (const response of await Promise.all(bad)) {
    expect(response.status).toBe(401);
    expect(response.headers.get("set-cookie")).toBeNull();
  }
  // Valid POST (c), GET (b) and upgrade (d) renew only the presented secret.
  const valid = await post(c, command("catalog.get"));
  expect(valid.status).toBe(200);
  expect(valid.headers.get("set-cookie")).toContain(c.cookie);
  expect((await getClient(b)).status).toBe(200);
  expect((await upgrade(d)).status).toBe(101);
  advance(t0 + EIGHT_HOURS + 1);
  expect((await getClient(a)).status).toBe(401);
  for (const s of [b, c, d]) expect((await getClient(s)).status).toBe(200);
});

it("idle sockets expire without traffic and renewal reschedules only the presented secret", async () => {
  const t0 = clock;
  const a = await login();
  const b = await login();
  const [a1, a2, b1] = [await open(a), await open(a), await open(b)];
  const closes = [a1, a2, b1].map((u) => closed(u.socket));
  advance(t0 + EIGHT_HOURS - 1);
  expect((await getClient(a)).status).toBe(200); // A -> t0 + 16h - 1
  expect(held.size).toBe(2); // one timer per secret with sockets
  advance(t0 + EIGHT_HOURS); // equality edge: `expires < now` is false
  expect(b1.socket.readyState).toBe(WebSocket.OPEN);
  advance(t0 + EIGHT_HOURS + 1);
  expect(await closes[2]).toBe(1008);
  expect(a1.socket.readyState).toBe(WebSocket.OPEN);
  expect(a2.socket.readyState).toBe(WebSocket.OPEN);
  expect(held.size).toBe(1);
  advance(t0 + 2 * EIGHT_HOURS - 1);
  expect(a1.socket.readyState).toBe(WebSocket.OPEN);
  advance(t0 + 2 * EIGHT_HOURS);
  expect(await closes[0]).toBe(1008);
  expect(await closes[1]).toBe(1008);
  expect(held.size).toBe(0);
});

it("a delayed expiry timer cannot leak inbound replay or live frames", async () => {
  const t0 = clock;
  const a = await login();
  const b = await login();
  const [aSocket, bSocket] = [await open(a), await open(b)];
  aSocket.socket.send(
    JSON.stringify({ v: 1, type: "subscribe", streamId: "catalog" }),
  );
  bSocket.socket.send(
    JSON.stringify({ v: 1, type: "subscribe", streamId: "catalog" }),
  );
  await aSocket.next((f) => f.type === "snapshot");
  await bSocket.next((f) => f.type === "snapshot");
  const bClose = closed(bSocket.socket);
  clock = t0 + EIGHT_HOURS + 1; // clock jump; the timer has not fired yet
  expect((await getClient(a)).status).toBe(401); // A expired as well
  const before = bSocket.frames.length;
  host.publish("catalog", "catalog.section", { label: "late" });
  bSocket.socket.send(
    JSON.stringify({ v: 1, type: "subscribe", streamId: "catalog" }),
  );
  expect(await bClose).toBe(1008);
  expect(bSocket.frames.length).toBe(before);
});

it("host shutdown clears socket expiry timers", async () => {
  const a = await login();
  const u = await open(a);
  expect(held.size).toBe(1);
  const gone = closed(u.socket);
  await host.close();
  await gone;
  expect(held.size).toBe(0);
});

it("serves exactly one of two racing bootstraps with the same nonce and both of separate nonces", async () => {
  const { nonce } = await control(root, { type: "bootstrap" });
  const racing = await Promise.all([
    bootstrapRequest(nonce),
    bootstrapRequest(nonce),
  ]);
  expect(racing.map((r) => r.status).sort()).toEqual([200, 401]);
  const winners = racing.filter((r) => r.status === 200);
  expect(winners[0].headers.get("set-cookie")).toMatch(
    /^suri_\d+=[a-f0-9]{64}; HttpOnly; SameSite=Strict; Path=\/; Max-Age=28800$/,
  );
  expect(
    racing.filter((r) => r.status === 401)[0].headers.get("set-cookie"),
  ).toBeNull();
  const winner = await readSession(winners[0]);
  expect((await getClient(winner)).status).toBe(200);

  const [nonceA, nonceB] = await Promise.all([
    control(root, { type: "bootstrap" }),
    control(root, { type: "bootstrap" }),
  ]);
  expect(nonceA.nonce).not.toBe(nonceB.nonce);
  const [a, b] = await Promise.all([
    bootstrapRequest(nonceA.nonce).then(readSession),
    bootstrapRequest(nonceB.nonce).then(readSession),
  ]);
  expect(a.clientId).not.toBe(b.clientId);
  expect(a.cookie).not.toBe(b.cookie);
  expect((await getClient(a)).status).toBe(200);
  expect((await getClient(b)).status).toBe(200);
});

it("rejects a bootstrap nonce after sixty seconds and consumes it even when rejected", async () => {
  const t0 = clock;
  const edge = await control(root, { type: "bootstrap" });
  const late = await control(root, { type: "bootstrap" });
  clock = t0 + NONCE_TTL; // host.ts rejects only when expires < now
  expect((await bootstrapRequest(edge.nonce)).status).toBe(200);
  clock = t0 + NONCE_TTL + 1;
  expect((await bootstrapRequest(late.nonce)).status).toBe(401);
  // The expired nonce was deleted by the failed attempt.
  clock = t0;
  expect((await bootstrapRequest(late.nonce)).status).toBe(401);
});

it("extends only the presented secret on GET or upgrade, not siblings sharing a clientId", async () => {
  const t0 = clock;
  const a1 = await login();
  const a2 = await login(a1.clientId);
  const a3 = await login(a1.clientId);
  expect(new Set([a1.clientId, a2.clientId, a3.clientId]).size).toBe(1);
  expect(new Set([a1.cookie, a2.cookie, a3.cookie]).size).toBe(3);
  expect(new Set([a1.csrf, a2.csrf, a3.csrf]).size).toBe(3);

  clock = t0 + EIGHT_HOURS - 1;
  const renewed = await Promise.all([getClient(a1), upgrade(a2)]);
  expect(renewed[0].status).toBe(200);
  expect(renewed[1].status).toBe(101);
  clock = t0 + EIGHT_HOURS + 1;
  expect((await getClient(a1)).status).toBe(200);
  expect((await getClient(a2)).status).toBe(200);
  expect((await getClient(a3)).status).toBe(401);
  expect((await upgrade(a3)).status).toBe(401);
});

it("control bootstrap with an existing clientId mints a new secret with preserved identity and single-use nonce", async () => {
  const t0 = clock;
  const a = await login();
  const { nonce } = await control(root, {
    type: "bootstrap",
    clientId: a.clientId,
  });
  const first = await bootstrapRequest(nonce);
  const reissued = await readSession(first);
  expect(reissued.clientId).toBe(a.clientId);
  expect(reissued.cookie).not.toBe(a.cookie);
  expect(reissued.csrf).not.toBe(a.csrf);
  expect((await bootstrapRequest(nonce)).status).toBe(401);
  // Old session is untouched by re-bootstrap; each secret has its own CSRF.
  const accepted = await post(a, command("catalog.get"));
  expect(((await accepted.json()) as any).status).toBe("completed");
  expect((await post(reissued, command("catalog.get"))).status).toBe(200);
  expect((await post(a, command("catalog.get"), reissued.csrf)).status).toBe(
    401,
  );

  // Independent expiry: renew only the new secret.
  clock = t0 + EIGHT_HOURS - 1;
  expect((await getClient(reissued)).status).toBe(200);
  clock = t0 + EIGHT_HOURS + 1;
  expect((await getClient(a)).status).toBe(401);
  expect((await getClient(reissued)).status).toBe(200);

  // Format-valid but unknown ids are honoured; malformed ids are ignored.
  const minted = randomUUID();
  const custom = await login(minted);
  expect(custom.clientId).toBe(minted);
  const malformed = await login("not-a-uuid");
  expect(malformed.clientId).toMatch(/^[a-f0-9-]{36}$/);
  expect(malformed.clientId).not.toBe("not-a-uuid");
});

it("expired and replayed nonces never issue cookies or client sessions", async () => {
  const t0 = clock;
  const refusal = async (response: Response) => {
    expect(response.status).toBe(401);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(await response.text()).not.toMatch(/csrf|clientId/);
  };
  // Valid first use, then replay.
  const valid = await control(root, { type: "bootstrap" });
  const session = await readSession(await bootstrapRequest(valid.nonce));
  await refusal(await bootstrapRequest(valid.nonce));
  expect((await getClient(session)).status).toBe(200);
  // Expired first use, then replay (also after the clock rewinds).
  const late = await control(root, { type: "bootstrap" });
  clock = t0 + NONCE_TTL + 1;
  await refusal(await bootstrapRequest(late.nonce));
  await refusal(await bootstrapRequest(late.nonce));
  clock = t0;
  await refusal(await bootstrapRequest(late.nonce));
});
