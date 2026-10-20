import { WebSocketServer, type WebSocket } from "ws";
import type { UpgradeListener } from "./host-http-types.js";
import {
  type Data,
  type Projection,
} from "../../../packages/protocol/src/index.js";
import { displayText } from "../../../packages/pi-adapter/src/index.js";
import { snapshotFrames } from "./framing.js";
import type { ModernUpdates } from "./modern-updates.js";
import type { Storage } from "./storage.js";
import type { Transport } from "./host-transport.js";

export type WsCaps = {
  onUpgrade: (listener: UpgradeListener) => void;
  origin: () => string;
  auth: Transport["auth"];
  trackWs: Transport["trackWs"];
  live: Transport["live"];
  terminalSnapshot: (terminalId: string) => Data;
  untrackWs: Transport["untrackWs"];
  registerSocket: (socket: WebSocket) => void;
  removeSocket: (socket: WebSocket) => void;
  subscribe: (socket: WebSocket, streamId: string) => void;
  unsubscribe: (socket: WebSocket, streamId: string) => void;
  store: Storage;
  modernUpdates: () => ModernUpdates | undefined;
  catalog: () => Record<string, unknown>;
};

/** Builds the event WebSocket server; listeners are attached only on request. */
export function createWs(caps: WsCaps) {
  const ws = new WebSocketServer({ noServer: true, maxPayload: 1048576 });
  return {
    registerUpgrade() {
      caps.onUpgrade((req, socket, head) => {
        try {
          if (
            req.url !== "/v1/events" ||
            req.headers.host !== caps.origin().slice(7) ||
            req.headers.origin !== caps.origin()
          )
            throw Error();
          caps.auth(req);
          ws.handleUpgrade(req, socket, head, (s) =>
            ws.emit("connection", s, req),
          );
        } catch {
          socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
          socket.destroy();
        }
      });
    },
    registerConnection() {
      ws.on("connection", (socket, request) => {
        caps.auth(request);
        caps.trackWs(socket, request);
        caps.registerSocket(socket);
        socket.on("close", () => {
          caps.removeSocket(socket);
          caps.untrackWs(socket);
        });
        socket.on("message", (bytes) => {
          try {
            if (!caps.live(socket)) throw Error();
            const modernUpdates = caps.modernUpdates();
            const p = JSON.parse(bytes.toString());
            if (
              p.v !== 1 ||
              !["subscribe", "unsubscribe"].includes(p.type) ||
              typeof p.streamId !== "string"
            )
              throw Error();
            if (
              p.streamId !== "catalog" &&
              !(modernUpdates && p.streamId === "updates") &&
              !p.streamId.startsWith("session:") &&
              !p.streamId.startsWith("terminal:")
            )
              throw Error();
            if (p.streamId.startsWith("session:"))
              caps.store.get("session", p.streamId.slice(8));
            if (p.type === "unsubscribe") {
              caps.unsubscribe(socket, p.streamId);
              return;
            }
            const terminal = p.streamId.startsWith("terminal:")
              ? caps.terminalSnapshot(p.streamId.slice(9))
              : undefined;
            caps.subscribe(socket, p.streamId);
            if (terminal) {
              for (const frame of snapshotFrames(
                p.streamId,
                terminal.cursor,
                caps.store.epoch,
                terminal,
              ))
                socket.send(JSON.stringify(frame));
              return;
            }
            const resumable =
              typeof p.afterSeq === "number" &&
              Number.isSafeInteger(p.afterSeq) &&
              p.afterSeq >= 0 &&
              p.hostEpoch === caps.store.epoch;
            const head = caps.store.head(p.streamId);
            if (resumable && p.afterSeq === head) return;
            const replay = resumable
              ? caps.store.replay(p.streamId, p.afterSeq)
              : [];
            const completeReplay =
              replay.length > 0 &&
              replay[0].seq === p.afterSeq + 1 &&
              replay.at(-1)!.seq === head &&
              replay.every(
                (event, index) =>
                  event.seq ===
                  (index ? replay[index - 1].seq : p.afterSeq) + 1,
              );
            if (completeReplay) {
              for (const event of replay) socket.send(JSON.stringify(event));
              return;
            }
            let state =
              modernUpdates && p.streamId === "updates"
                ? { ...modernUpdates.snapshot(), seq: head }
                : p.streamId === "catalog"
                  ? { ...caps.catalog(), seq: head }
                  : caps.store.snapshot(p.streamId);
            const sessionState =
              p.streamId === "catalog" ? undefined : (state as Projection);
            if (sessionState?.extensions)
              state = {
                ...sessionState,
                extensions: Object.fromEntries(
                  Object.entries(sessionState.extensions).map(
                    ([key, extension]) => [
                      key,
                      {
                        ...extension,
                        text: displayText(extension.text),
                        lines: Array.isArray(extension.lines)
                          ? extension.lines.map(displayText)
                          : [],
                      },
                    ],
                  ),
                ),
              };
            for (const frame of snapshotFrames(
              p.streamId,
              state.seq,
              caps.store.epoch,
              state,
            ))
              socket.send(JSON.stringify(frame));
          } catch {
            socket.close(1008);
          }
        });
      });
    },
    close(callback?: () => void) {
      ws.close(callback);
    },
  };
}
