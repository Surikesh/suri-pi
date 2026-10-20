import { randomUUID } from "node:crypto";
import type { Data } from "../../../packages/protocol/src/index.js";

/** Sole owner of pending extension interactions and their expiry timers. */
export function createInteractions(caps: {
  client: (
    sessionId: string,
  ) => { respond: (id: string, answer: Data) => unknown } | undefined;
  publish: (stream: string, type: string, p: Data) => unknown;
}) {
  const interactions = new Map<
    string,
    { sessionId: string; raw: Data; timer: NodeJS.Timeout }
  >();
  return {
    request(sessionId: string, p: Data, method: string) {
      const id = randomUUID();
      const timeout = Math.min(Math.max(p.timeout ?? 300000, 1000), 300000);
      const timer = setTimeout(() => {
        caps.client(sessionId)?.respond(p.id, { cancelled: true });
        interactions.delete(id);
        caps.publish(`session:${sessionId}`, "interaction.closed", {
          interactionId: id,
          reason: "expired",
        });
      }, timeout);
      interactions.set(id, { sessionId, raw: p, timer });
      caps.publish(`session:${sessionId}`, "interaction.request", {
        interactionId: id,
        method,
        title: String(p.title ?? ""),
        message: String(p.message ?? ""),
        options: Array.isArray(p.options) ? p.options : [],
        prefill: String(p.prefill ?? p.text ?? ""),
        deadline: new Date(Date.now() + timeout).toISOString(),
      });
    },
    get: (interactionId: string) => interactions.get(interactionId),
    delete: (interactionId: string) => interactions.delete(interactionId),
    hasSession: (id: string) =>
      [...interactions.values()].some((item) => item.sessionId === id),
    sessionIds: () => [...interactions.values()].map((item) => item.sessionId),
    clearTimers() {
      for (const i of interactions.values()) clearTimeout(i.timer);
    },
  };
}
export type Interactions = ReturnType<typeof createInteractions>;
