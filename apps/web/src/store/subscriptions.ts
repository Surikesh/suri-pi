import { viewStorage as localStorage } from "../view-storage.js";
import type { Data } from "../../../../packages/protocol/src/index.js";
import {
  getSocket,
  getState,
  projectionEpochs,
  projectionHeads,
  update,
} from "./internal.js";
export function select(id?: string) {
  const previous = getState().selected;
  if (id) localStorage.setItem("suri.selected", id);
  else localStorage.removeItem("suri.selected");
  const url = new URL(location.href);
  if (id) url.searchParams.set("session", id);
  else url.searchParams.delete("session");
  history.replaceState(null, "", url.pathname + url.search);
  update({ selected: id });
  if (previous && previous !== id) unsubscribe(`session:${previous}`);
  if (id) subscribe(`session:${id}`);
}
(
  window as unknown as { suriSelectSession?: (id: string) => void }
).suriSelectSession = select;
function subscriptionRequest(streamId: string): Data {
  const sessionId = streamId.startsWith("session:") ? streamId.slice(8) : "";
  const projection = sessionId
    ? (projectionHeads[sessionId] ?? getState().projections[sessionId])
    : undefined;
  return {
    v: 1,
    type: "subscribe",
    streamId,
    ...(projection &&
    getState().hostEpoch &&
    projectionEpochs[sessionId] === getState().hostEpoch
      ? { afterSeq: projection.seq, hostEpoch: getState().hostEpoch }
      : {}),
  };
}
export function subscribe(streamId: string) {
  const socket = getSocket();
  if (socket?.readyState === WebSocket.OPEN)
    socket.send(JSON.stringify(subscriptionRequest(streamId)));
}
function unsubscribe(streamId: string) {
  const socket = getSocket();
  if (socket?.readyState === WebSocket.OPEN)
    socket.send(JSON.stringify({ v: 1, type: "unsubscribe", streamId }));
}
