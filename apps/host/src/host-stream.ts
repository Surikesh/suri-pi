import { WebSocket } from "ws";
import type { Data } from "../../../packages/protocol/src/index.js";
import type { Storage } from "./storage.js";
import type { Transport } from "./host-transport.js";

/**
 * Sole owner of WebSocket stream subscriptions and the durable publish /
 * terminal fanout path. Store event commit happens before any socket send.
 */
export function createStream(caps: { store: Storage; transport: Transport }) {
  const { store } = caps;
  const subscriptions = new Map<WebSocket, Set<string>>();
  const registerSocket = (socket: WebSocket) => {
    subscriptions.set(socket, new Set());
  };
  const removeSocket = (socket: WebSocket) => {
    subscriptions.delete(socket);
  };
  const subscribe = (socket: WebSocket, streamId: string) => {
    subscriptions.get(socket)!.add(streamId);
  };
  const unsubscribe = (socket: WebSocket, streamId: string) => {
    subscriptions.get(socket)!.delete(streamId);
  };
  /** Sends only to OPEN sockets whose own secret is still valid. */
  const open = (socket: WebSocket) => {
    if (socket.readyState !== WebSocket.OPEN) return false;
    if (caps.transport.live(socket)) return true;
    socket.close(1008);
    return false;
  };
  const publish = (stream: string, type: string, p: Data) => {
    const e = store.event(stream, type, p);
    for (const [socket, streams] of subscriptions)
      if (streams.has(stream) && open(socket)) {
        if (socket.bufferedAmount > 4194304) socket.close(1013);
        else socket.send(JSON.stringify(e));
      }
    // Catalog subscribers need phase changes even without the session stream.
    if (
      stream.startsWith("session:") &&
      ["run.state", "session.state"].includes(type)
    )
      publish("catalog", "catalog.sessionPhase", {
        sessionId: stream.slice(8),
        phase: p.phase,
        seq: e.seq,
      });
    return e;
  };
  const fanoutTerminal = (id: string, type: string, p: Data) => {
    for (const [socket, streams] of subscriptions)
      if (streams.has(`terminal:${id}`) && open(socket))
        socket.send(
          JSON.stringify({
            v: 1,
            hostEpoch: store.epoch,
            type,
            payload: p,
            streamId: `terminal:${id}`,
            seq: p.cursor ?? 0,
          }),
        );
  };
  return {
    registerSocket,
    removeSocket,
    subscribe,
    unsubscribe,
    publish,
    fanoutTerminal,
    /** Shutdown: terminates every subscribed socket in registration order. */
    terminateAll() {
      for (const socket of subscriptions.keys()) socket.terminate();
    },
  };
}
export type Stream = ReturnType<typeof createStream>;
