import type { IncomingMessage, ServerResponse } from "node:http";
import type { WebSocket } from "ws";
import { SuriError } from "../../../packages/protocol/src/index.js";

type ClientEntry = {
  id: string;
  csrf: string;
  expires: number;
  build?: string;
  previous?: string;
  restartOperationId?: string;
};
type NonceEntry = {
  expires: number;
  clientId?: string;
  restartOperationId?: string;
};

/** Sole owner of client secrets, bootstrap nonces and secret-bound sockets. */
export function createTransport(caps: { cookieName: () => string }) {
  const clients = new Map<string, ClientEntry>();
  const nonces = new Map<string, NonceEntry>();
  const sockets = new Map<string, Set<WebSocket>>();
  const socketSecrets = new Map<WebSocket, string>();
  const timers = new Map<string, NodeJS.Timeout>();
  const lookup = (req: IncomingMessage) => {
    const cookieName = caps.cookieName();
    const secret = (req.headers.cookie ?? "")
      .split(";")
      .map((x) => x.trim())
      .find((x) => x.startsWith(`${cookieName}=`))
      ?.slice(cookieName.length + 1);
    const client = secret ? clients.get(secret) : undefined;
    if (!secret || !client || client.expires < Date.now())
      throw new SuriError(
        "UNAUTHORIZED",
        "Open Suri through its native app or local CLI.",
      );
    return { cookieName, secret, client };
  };
  const closeSecret = (secret: string) => {
    clearTimeout(timers.get(secret));
    timers.delete(secret);
    for (const socket of [...(sockets.get(secret) ?? [])]) socket.close(1008);
  };
  /** One timer per secret with sockets; strict `< now` expiry, so +1ms. */
  const arm = (secret: string) => {
    clearTimeout(timers.get(secret));
    timers.delete(secret);
    const client = clients.get(secret);
    if (!client || !sockets.get(secret)?.size) return;
    const timer = setTimeout(
      () => {
        timers.delete(secret);
        if (client.expires < Date.now()) closeSecret(secret);
        else arm(secret);
      },
      Math.max(0, client.expires - Date.now() + 1),
    );
    timer.unref();
    timers.set(secret, timer);
  };
  /** Authorizes the request; renews the presented secret only (not `peek`). */
  const auth = (req: IncomingMessage, res?: ServerResponse) => {
    const { cookieName, secret, client } = lookup(req);
    client.expires = Date.now() + 8 * 3600000;
    if (sockets.has(secret)) arm(secret);
    if (res)
      res.setHeader(
        "Set-Cookie",
        `${cookieName}=${secret}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800`,
      );
    return client;
  };
  return {
    auth,
    /** Nonmutating authorization: never extends expiry or sets cookies. */
    peek: (req: IncomingMessage) => lookup(req).client,
    /** Nonrenewing check that the socket's own secret is still valid. */
    live(socket: WebSocket) {
      const secret = socketSecrets.get(socket);
      const client = secret ? clients.get(secret) : undefined;
      return !!client && client.expires >= Date.now();
    },
    addNonce(nonce: string, entry: NonceEntry) {
      nonces.set(nonce, entry);
    },
    /** Reads then deletes the presented nonce in one synchronous step. */
    takeNonce(nonce: string) {
      const expires = nonces.get(nonce);
      nonces.delete(nonce);
      return expires;
    },
    addClient(secret: string, entry: ClientEntry) {
      clients.set(secret, entry);
    },
    trackWs(socket: WebSocket, req: IncomingMessage) {
      const { secret } = lookup(req);
      socketSecrets.set(socket, secret);
      sockets.set(secret, (sockets.get(secret) ?? new Set()).add(socket));
      arm(secret);
    },
    untrackWs(socket: WebSocket) {
      const secret = socketSecrets.get(socket);
      socketSecrets.delete(socket);
      if (!secret) return;
      const bound = sockets.get(secret);
      bound?.delete(socket);
      if (!bound?.size) {
        sockets.delete(secret);
        clearTimeout(timers.get(secret));
        timers.delete(secret);
      }
    },
    revokeRestartOperation(operationId: string) {
      for (const [nonce, pending] of nonces)
        if (pending.restartOperationId === operationId) nonces.delete(nonce);
      for (const [secret, client] of clients)
        if (client.restartOperationId === operationId) {
          clients.delete(secret);
          closeSecret(secret);
        }
    },
  };
}
export type Transport = ReturnType<typeof createTransport>;
