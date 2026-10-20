import { SnapshotAssembler } from "../assembly.js";
import { viewStorage as localStorage } from "../view-storage.js";
import {
  initialProjection,
  reduce,
  type Data,
  type Projection,
} from "../../../../packages/protocol/src/index.js";
import { refresh, report } from "./commands.js";
import {
  bumpCatalogRefresh,
  clearNativeReauthentication,
  draftRevisions,
  earlyResults,
  getClientId,
  getSocket,
  getState,
  isCatalogLoaded,
  isNativeReauthenticationRequested,
  pending,
  projectionEpochs,
  projectionHeads,
  requestNativeReauthentication,
  setCatalogLoaded,
  setClientId,
  setCsrf,
  setSocket,
  update,
} from "./internal.js";
import { select, subscribe } from "./subscriptions.js";
export async function connect() {
  try {
    const nonce = new URLSearchParams(location.hash.slice(1)).get("nonce");
    if (nonce)
      history.replaceState(null, "", location.pathname + location.search);
    const response = await fetch(
      nonce ? "/v1/bootstrap" : "/v1/client",
      nonce
        ? {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ nonce }),
          }
        : {},
    );
    if (!response.ok) {
      if (
        response.status === 401 &&
        (isNativeReauthenticationRequested() || requestNativeReauthentication())
      )
        return;
      throw Error("Open Suri Pi from the native app or run npm start.");
    }
    const client = await response.json();
    setCsrf(client.csrf);
    setClientId(client.clientId);
    clearNativeReauthentication();
    update({ ready: true, error: undefined });
    await refresh();
    const linked = new URLSearchParams(location.search).get("session");
    if (
      linked &&
      getState().catalog.sessions.some((s: Data) => s.id === linked)
    )
      select(linked);
    openSocket();
  } catch (e) {
    report(e);
  }
}
let retry = 0;
const queuedProjections = new Map<string, Projection>();
let projectionFrame = 0;
function invalidateProjections() {
  for (const id of Object.keys(projectionHeads)) delete projectionHeads[id];
  for (const id of Object.keys(projectionEpochs)) delete projectionEpochs[id];
  queuedProjections.clear();
}
function queueProjection(
  id: string,
  projection: Projection,
  hostEpoch: string,
) {
  projectionHeads[id] = projection;
  projectionEpochs[id] = hostEpoch;
  queuedProjections.set(id, projection);
  if (projectionFrame) return;
  projectionFrame = requestAnimationFrame(() => {
    projectionFrame = 0;
    if (!queuedProjections.size) return;
    const projections = { ...getState().projections };
    for (const [sessionId, next] of queuedProjections)
      projections[sessionId] = next;
    queuedProjections.clear();
    update({ projections });
  });
}
function updateConnectionPaused() {
  return (
    window.suriUpdate?.ready &&
    document.documentElement.dataset.suriUpdating === "true"
  );
}
if (window.suriUpdate)
  window.addEventListener("suri-update-unlocked", () => {
    if (
      getState().ready &&
      !getState().connected &&
      getSocket()?.readyState !== WebSocket.CONNECTING
    )
      openSocket();
  });
function openSocket() {
  if (window.suriReconnectRequired || updateConnectionPaused()) return;
  const socket = getSocket();
  if (
    window.suriUpdate &&
    (socket?.readyState === WebSocket.OPEN ||
      socket?.readyState === WebSocket.CONNECTING)
  )
    return;
  const openedSocket = new WebSocket(
    `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/v1/events`,
  );
  setSocket(openedSocket);
  let active = true;
  const isCurrent = () => active && getSocket() === openedSocket;
  openedSocket.onopen = () => {
    if (!isCurrent()) return;
    retry = 0;
    update({ connected: true });
    subscribe("catalog");
    if (getState().selected) subscribe(`session:${getState().selected}`);
  };
  openedSocket.onclose = () => {
    if (!isCurrent()) return;
    active = false;
    update({ connected: false });
    if (updateConnectionPaused()) return;
    void fetch("/v1/client")
      .then((response) => {
        if (
          response.status === 401 &&
          (isNativeReauthenticationRequested() ||
            requestNativeReauthentication())
        )
          return;
        setTimeout(
          openSocket,
          Math.min(5000, 250 * 2 ** retry++) + Math.random() * 100,
        );
      })
      .catch(() => {
        if (requestNativeReauthentication()) return;
        setTimeout(
          openSocket,
          Math.min(5000, 250 * 2 ** retry++) + Math.random() * 100,
        );
      });
  };
  const receive = (event: Data) => {
    if (!isCurrent()) return;
    if (event.type === "snapshot") {
      if (event.streamId === "catalog") {
        bumpCatalogRefresh();
        setCatalogLoaded(true);
        const epochChanged = getState().hostEpoch !== event.hostEpoch;
        if (epochChanged) invalidateProjections();
        update({
          catalog: event.payload,
          hostEpoch: event.hostEpoch,
          ...(epochChanged ? { projections: {} } : {}),
        });
      } else if (event.streamId.startsWith("session:")) {
        const epochChanged = getState().hostEpoch !== event.hostEpoch;
        if (epochChanged) {
          invalidateProjections();
          update({ hostEpoch: event.hostEpoch, projections: {} });
        }
        queueProjection(
          event.streamId.slice(8),
          event.payload,
          event.hostEpoch,
        );
      }
      return;
    }
    if (
      event.type === "draft.restored" &&
      event.payload.clientId === (window.suriUpdate?.client ?? getClientId())
    ) {
      const id = event.streamId.slice(8),
        marker = `suri.restored.${id}`;
      if (Number.isSafeInteger(event.payload.revision))
        draftRevisions.set(
          id,
          Math.max(draftRevisions.get(id) ?? 0, event.payload.revision),
        );
      if (Number(localStorage.getItem(marker) ?? 0) < event.seq) {
        localStorage.setItem(marker, String(event.seq));
        const key = `suri.draft.${id}`;
        localStorage.setItem(
          key,
          [localStorage.getItem(key), event.payload.text]
            .filter(Boolean)
            .join("\n\n"),
        );
        const attachments = JSON.parse(
          localStorage.getItem(`suri.attachments.${id}`) ?? "[]",
        );
        const merged = [
          ...new Map(
            [...attachments, ...event.payload.attachments].map((a) => [
              a.id,
              a,
            ]),
          ).values(),
        ];
        localStorage.setItem(`suri.attachments.${id}`, JSON.stringify(merged));
        window.dispatchEvent(
          new CustomEvent("suri-draft-restored", { detail: { sessionId: id } }),
        );
      }
    }
    if (event.type === "command.result") {
      earlyResults.set(event.payload.id, {
        status: event.payload.status,
        error: event.payload.error,
        result: event.payload.result,
      });
      if (earlyResults.size > 1000)
        earlyResults.delete(earlyResults.keys().next().value!);

      const saved = localStorage.getItem(`suri.outbox.${event.payload.id}`);
      if (saved) {
        const item = JSON.parse(saved);
        if (event.payload.status === "rejected") {
          const key = `suri.draft.${item.sessionId}`;
          const current = localStorage.getItem(key) ?? "";
          localStorage.setItem(
            key,
            current === item.text
              ? current
              : [item.text, current].filter(Boolean).join("\n\n"),
          );
          const attachmentKey = `suri.attachments.${item.sessionId}`;
          const previous =
            item.attachments ??
            item.attachmentIds.map((id: string) => ({
              id,
              name: "Recovered attachment",
              mime: "application/octet-stream",
            }));
          const merged = new Map(
            [
              ...previous,
              ...JSON.parse(localStorage.getItem(attachmentKey) ?? "[]"),
            ].map((a: Data) => [a.id, a]),
          );
          localStorage.setItem(
            attachmentKey,
            JSON.stringify([...merged.values()]),
          );
          localStorage.removeItem(`suri.outbox.${event.payload.id}`);
          window.dispatchEvent(
            new CustomEvent("suri-draft-restored", {
              detail: { sessionId: item.sessionId },
            }),
          );
        }
        if (event.payload.status === "completed")
          localStorage.removeItem(`suri.outbox.${event.payload.id}`);
      }

      const p = pending.get(event.payload.id);
      if (p) {
        clearTimeout(p.timer);
        pending.delete(event.payload.id);
        p.resolve(event.payload);
      }
      if (event.payload.status === "rejected")
        report(Error(event.payload.error?.message ?? "Operation rejected."));
      void refresh();
    }
    if (event.streamId === "catalog") {
      void refresh();
      return;
    }
    if (event.streamId?.startsWith("terminal:")) {
      window.dispatchEvent(new CustomEvent("suri-terminal", { detail: event }));
      return;
    }
    const id = event.sessionId;
    if (!id) return;
    const old =
      projectionHeads[id] ?? getState().projections[id] ?? initialProjection();
    if (event.seq > old.seq + 1) {
      subscribe(event.streamId);
      return;
    }
    queueProjection(
      id,
      reduce(old, {
        type: event.type,
        payload: event.payload,
        seq: event.seq,
      }),
      getState().hostEpoch!,
    );
  };
  const assembler = new SnapshotAssembler(receive, (streamId) => {
    if (isCurrent()) subscribe(streamId);
  });
  openedSocket.onmessage = (e) => {
    if (!isCurrent()) return;
    try {
      const arrived = performance.now();
      const event = JSON.parse(e.data);
      assembler.receive(event);
      if (
        new URLSearchParams(location.search).has("nativeBenchmark") &&
        event.type === "message.upsert"
      ) {
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            const target = window as unknown as { suriPaintSamples?: number[] };
            target.suriPaintSamples ??= [];
            target.suriPaintSamples.push(performance.now() - arrived);
            if (target.suriPaintSamples.length > 500)
              target.suriPaintSamples.shift();
          }),
        );
      }
    } catch {
      if (isCurrent()) openedSocket.close();
    }
  };
}

Object.defineProperty(window, "suriReady", {
  get: () =>
    getState().connected &&
    isCatalogLoaded() &&
    !!getState().hostEpoch &&
    (!window.suriUpdate || window.suriViewReady?.() === true) &&
    !!document.querySelector(".shell") &&
    !document.querySelector("[data-required-chunk-loading]") &&
    (!getState().selected ||
      !getState().catalog.sessions.some(
        (session: Data) => session.id === getState().selected,
      ) ||
      !!getState().projections[getState().selected!]),
  configurable: true,
});
