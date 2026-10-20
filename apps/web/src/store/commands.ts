import { viewStorage as localStorage } from "../view-storage.js";
import type { Data, Receipt } from "../../../../packages/protocol/src/index.js";
import {
  authenticatedFetch,
  bumpCatalogRefresh,
  draftRevisions,
  earlyResults,
  getCatalogRefresh,
  getCsrf,
  getState,
  pending,
  setCatalogLoaded,
  update,
} from "./internal.js";
import { select, subscribe } from "./subscriptions.js";
const draftWrites = new Map<string, Promise<Data>>();
export const viewDraftRevision = (sessionId: string) =>
  draftRevisions.get(sessionId) ?? 0;
export async function command(
  type: string,
  payload: Data = {},
  sessionId?: string,
  expectedRevision?: number,
): Promise<Data> {
  if (type !== "draft.save" || !sessionId || !window.suriUpdate)
    return performCommand(type, payload, sessionId, expectedRevision);
  const previous = draftWrites.get(sessionId) ?? Promise.resolve({});
  // A failed earlier draft save was reported to its own caller; it must not block later saves.
  const write = previous
    .catch(() => ({}))
    .then(() =>
      performCommand(type, payload, sessionId, draftRevisions.get(sessionId)),
    );
  draftWrites.set(sessionId, write);
  try {
    return await write;
  } finally {
    if (draftWrites.get(sessionId) === write) draftWrites.delete(sessionId);
  }
}
async function performCommand(
  type: string,
  payload: Data = {},
  sessionId?: string,
  expectedRevision?: number,
): Promise<Data> {
  if (!getState().ready) throw Error("Connection is not ready.");
  if (
    window.suriUpdate &&
    ["draft.get", "draft.save", "run.cancel", "queue.clear"].includes(type)
  )
    payload = { ...payload, clientInstanceId: window.suriUpdate.client };
  const id = crypto.randomUUID();
  if (sessionId) subscribe(`session:${sessionId}`);
  const c = {
    v: 1,
    id,
    createdAt: new Date().toISOString(),
    type,
    payload,
    sessionId,
    expectedRevision,
  };
  if (type === "run.submit")
    localStorage.setItem(
      `suri.outbox.${id}`,
      JSON.stringify({
        id,
        sessionId,
        text: payload.text,
        attachmentIds: payload.attachmentIds,
        attachments: JSON.parse(
          localStorage.getItem(`suri.attachments.${sessionId}`) ?? "[]",
        ),
      }),
    );
  const receipt = (await authenticatedFetch("/v1/commands", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Suri-Csrf": getCsrf() },
    body: JSON.stringify(c),
  }).then((r) => r.json())) as Receipt;
  const early = earlyResults.get(id);
  if (early?.status === "rejected" || early?.status === "indeterminate")
    throw Error(early.error?.message ?? "Delivery is uncertain.");
  if (receipt.status === "rejected" || receipt.status === "indeterminate")
    throw Error(
      receipt.error?.message ??
        "Delivery is uncertain. Refresh before submitting again.",
    );
  if (receipt.status === "accepted") {
    if (type === "run.submit") return { accepted: true, requestId: id };
    const outcome =
      early ??
      (await new Promise<Data>((resolve, reject) => {
        // Re-read the same idempotent receipt if a result crossed a reconnect or
        // a subscription boundary. This never creates a second operation.
        let checking = false;
        const reconcile = setInterval(() => {
          if (checking) return;
          checking = true;
          // A failed reconcile poll is retried on the next interval; the command timeout still settles the promise.
          void authenticatedFetch("/v1/commands", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Suri-Csrf": getCsrf(),
            },
            body: JSON.stringify(c),
          })
            .then((r) => r.json())
            .then((r: Receipt) => {
              if (r.status !== "accepted") finish(r);
            })
            .catch(() => undefined)
            .finally(() => {
              checking = false;
            });
        }, 1000);
        const finish = (result: Data) => {
          clearInterval(reconcile);
          clearTimeout(timer);
          pending.delete(id);
          resolve(result);
        };
        const timer = setTimeout(() => {
          clearInterval(reconcile);
          pending.delete(id);
          reject(
            Error(
              "The operation is still pending. Reconnect to inspect its result.",
            ),
          );
        }, 30000);
        pending.set(id, { resolve: finish, reject, timer });
      }));
    if (outcome.status !== "completed")
      throw Error(outcome.error?.message ?? "Operation did not complete.");
    return outcome.result ?? {};
  }
  if (
    sessionId &&
    ["draft.get", "draft.save"].includes(type) &&
    Number.isSafeInteger(receipt.result?.revision)
  )
    draftRevisions.set(
      sessionId,
      Math.max(draftRevisions.get(sessionId) ?? 0, receipt.result!.revision),
    );
  return receipt.result ?? {};
}
export async function refresh() {
  const generation = bumpCatalogRefresh();
  try {
    const catalog = await command("catalog.get");
    if (generation === getCatalogRefresh()) {
      setCatalogLoaded(true);
      update({ catalog });
      if (
        getState().selected &&
        !catalog.sessions.some(
          (session: Data) => session.id === getState().selected,
        )
      )
        select();
    }
  } catch (e) {
    if (generation === getCatalogRefresh()) report(e);
  }
}
export function report(error: unknown) {
  update({ error: error instanceof Error ? error.message : String(error) });
}
export function dismiss() {
  update({ error: undefined });
}
