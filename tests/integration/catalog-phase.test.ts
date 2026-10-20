import { it, expect } from "vitest";
import { once } from "node:events";
import WebSocket from "ws";
import { browserHost } from "../support/browser-host.js";
import { control } from "../../apps/host/src/cli.js";
import { Translator } from "../../packages/pi-adapter/src/index.js";

it("keeps an exact-head session subscription without parsing or retransmitting a snapshot", async () => {
  const fixture = await browserHost();
  let socket: WebSocket | undefined;
  try {
    const streamId = `session:${fixture.session.id}`;
    fixture.host.publish(streamId, "usage.updated", { input: 1 });
    const head = fixture.host.store.head(streamId);
    const { nonce } = await control(fixture.data, { type: "bootstrap" });
    const response = await fetch(fixture.host.origin + "/v1/bootstrap", {
      method: "POST",
      headers: {
        Origin: fixture.host.origin,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ nonce }),
    });
    socket = new WebSocket(
      fixture.host.origin.replace("http:", "ws:") + "/v1/events",
      {
        headers: {
          Origin: fixture.host.origin,
          Cookie: response.headers.get("set-cookie")!.split(";")[0],
        },
      },
    );
    await once(socket, "open");
    const received: unknown[] = [];
    socket.on("message", (bytes) =>
      received.push(JSON.parse(bytes.toString())),
    );
    const originalSnapshot = fixture.host.store.snapshot.bind(
      fixture.host.store,
    );
    let sessionSnapshotReads = 0;
    fixture.host.store.snapshot = ((requested: string) => {
      if (requested === streamId) sessionSnapshotReads++;
      return originalSnapshot(requested);
    }) as typeof fixture.host.store.snapshot;

    const request = {
      v: 1,
      type: "subscribe",
      streamId,
      afterSeq: head,
      hostEpoch: fixture.host.store.epoch,
    };
    socket.send(JSON.stringify(request));
    socket.send(JSON.stringify(request));
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(received).toEqual([]);
    expect(sessionSnapshotReads).toBe(0);
    fixture.host.publish(streamId, "usage.updated", { input: 2 });
    await expect.poll(() => received.length).toBe(1);
    expect(received[0]).toMatchObject({ seq: head + 1, streamId });
  } finally {
    socket?.terminate();
    await fixture.close();
  }
});

it("replays only complete ordered coverage and snapshots every invalid resume", async () => {
  const fixture = await browserHost();
  let socket: WebSocket | undefined;
  try {
    const { nonce } = await control(fixture.data, { type: "bootstrap" });
    const response = await fetch(fixture.host.origin + "/v1/bootstrap", {
      method: "POST",
      headers: {
        Origin: fixture.host.origin,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ nonce }),
    });
    socket = new WebSocket(
      fixture.host.origin.replace("http:", "ws:") + "/v1/events",
      {
        headers: {
          Origin: fixture.host.origin,
          Cookie: response.headers.get("set-cookie")!.split(";")[0],
        },
      },
    );
    await once(socket, "open");
    const received: any[] = [];
    socket.on("message", (bytes) =>
      received.push(JSON.parse(bytes.toString())),
    );
    const originalHead = fixture.host.store.head.bind(fixture.host.store);
    const originalReplay = fixture.host.store.replay.bind(fixture.host.store);
    const originalSnapshot = fixture.host.store.snapshot.bind(
      fixture.host.store,
    );
    const streamId = `session:${fixture.session.id}`;
    const event = (seq: number) => ({
      v: 1,
      type: "usage.updated",
      streamId,
      sessionId: fixture.session.id,
      hostEpoch: fixture.host.store.epoch,
      seq,
      at: new Date(0).toISOString(),
      payload: { input: seq },
    });
    let replayEvents: any[] = [];
    fixture.host.store.head = ((requested: string) =>
      requested === streamId
        ? 3
        : originalHead(requested)) as typeof fixture.host.store.head;
    fixture.host.store.replay = ((requested: string, after: number) =>
      requested === streamId
        ? replayEvents
        : originalReplay(requested, after)) as typeof fixture.host.store.replay;
    fixture.host.store.snapshot = ((requested: string) =>
      requested === streamId
        ? { ...originalSnapshot(requested), seq: 3 }
        : originalSnapshot(requested)) as typeof fixture.host.store.snapshot;

    const subscribe = async (
      resume: { afterSeq?: number; hostEpoch?: string },
      count: number,
    ) => {
      const start = received.length;
      socket!.send(
        JSON.stringify({ v: 1, type: "subscribe", streamId, ...resume }),
      );
      await expect.poll(() => received.length - start).toBe(count);
      return received.slice(start);
    };
    const epoch = fixture.host.store.epoch;
    replayEvents = [event(2), event(3)];
    expect(await subscribe({ afterSeq: 1, hostEpoch: epoch }, 2)).toMatchObject(
      [{ seq: 2 }, { seq: 3 }],
    );
    for (const [resume, replay] of [
      [{}, []],
      [{ afterSeq: 1, hostEpoch: "obsolete" }, []],
      [{ afterSeq: 4, hostEpoch: epoch }, []],
      [{ afterSeq: 1.5, hostEpoch: epoch }, []],
      [{ afterSeq: 0, hostEpoch: epoch }, [event(1), event(3)]],
      [{ afterSeq: 0, hostEpoch: epoch }, [event(1), event(2)]],
    ] as const) {
      replayEvents = [...replay];
      expect(await subscribe(resume, 1)).toMatchObject([
        { type: "snapshot", streamId, seq: 3, hostEpoch: epoch },
      ]);
    }
  } finally {
    socket?.terminate();
    await fixture.close();
  }
});

it("session subscribers can detach from background streams", async () => {
  const fixture = await browserHost();
  let socket: WebSocket | undefined;
  try {
    const { nonce } = await control(fixture.data, { type: "bootstrap" });
    const response = await fetch(fixture.host.origin + "/v1/bootstrap", {
      method: "POST",
      headers: {
        Origin: fixture.host.origin,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ nonce }),
    });
    socket = new WebSocket(
      fixture.host.origin.replace("http:", "ws:") + "/v1/events",
      {
        headers: {
          Origin: fixture.host.origin,
          Cookie: response.headers.get("set-cookie")!.split(";")[0],
        },
      },
    );
    await once(socket, "open");
    const received: any[] = [];
    socket.on("message", (bytes) =>
      received.push(JSON.parse(bytes.toString())),
    );
    const streamId = `session:${fixture.session.id}`;
    socket.send(JSON.stringify({ v: 1, type: "subscribe", streamId }));
    await expect.poll(() => received.length).toBeGreaterThan(0);
    socket.send(JSON.stringify({ v: 1, type: "unsubscribe", streamId }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    const count = received.length;
    fixture.host.publish(streamId, "usage.updated", { input: 1 });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(received).toHaveLength(count);
    socket.send(JSON.stringify({ v: 1, type: "subscribe", streamId }));
    await expect.poll(() => received.length).toBeGreaterThan(count);
  } finally {
    socket?.terminate();
    await fixture.close();
  }
});

it("catalog-only subscribers observe background run start, completion, error and cancellation", async () => {
  const fixture = await browserHost();
  let socket: WebSocket | undefined;
  try {
    const { nonce } = await control(fixture.data, { type: "bootstrap" });
    const response = await fetch(fixture.host.origin + "/v1/bootstrap", {
      method: "POST",
      headers: {
        Origin: fixture.host.origin,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ nonce }),
    });
    socket = new WebSocket(
      fixture.host.origin.replace("http:", "ws:") + "/v1/events",
      {
        headers: {
          Origin: fixture.host.origin,
          Cookie: response.headers.get("set-cookie")!.split(";")[0],
        },
      },
    );
    await once(socket, "open");
    const received: any[] = [];
    socket.on("message", (bytes) =>
      received.push(JSON.parse(bytes.toString())),
    );
    const snapshot = once(socket, "message");
    socket.send(
      JSON.stringify({ v: 1, type: "subscribe", streamId: "catalog" }),
    );
    await snapshot;
    const translator = new Translator((type, payload) => {
      fixture.host.publish(`session:${fixture.session.id}`, type, payload);
    });
    for (const stopReason of ["stop", "error", "aborted"]) {
      translator.record({ type: "agent_start" });
      translator.record({
        type: "message_end",
        message: { role: "assistant", content: [], stopReason },
      });
      translator.record({ type: "agent_settled" });
    }
    fixture.host.publish(`session:${fixture.session.id}`, "session.state", {
      phase: "interrupted",
      outcome: "interrupted",
    });
    await expect
      .poll(
        () => received.filter((e) => e.type === "catalog.sessionPhase").length,
      )
      .toBe(7);
    const phases = received.filter((e) => e.type === "catalog.sessionPhase");
    expect(phases.map((e) => e.payload.phase)).toEqual([
      "running",
      "idle",
      "running",
      "idle",
      "running",
      "idle",
      "interrupted",
    ]);
    expect(
      phases.every(
        (e) =>
          e.payload.sessionId === fixture.session.id &&
          Number.isInteger(e.payload.seq),
      ),
    ).toBe(true);
    expect(received.every((e) => e.streamId === "catalog")).toBe(true);
  } finally {
    socket?.terminate();
    await fixture.close();
  }
});
