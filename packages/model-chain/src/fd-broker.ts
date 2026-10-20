import { Socket } from "node:net";
import {
  destroyBrokerKey,
  parseBrokerHandshake,
  signBrokerFrame,
  verifyBrokerFrame,
} from "./broker-framing.js";

export type SuriChainTransport = (
  packet: Record<string, unknown>,
) => Promise<unknown>;

type BrokerClient = {
  transport: SuriChainTransport;
  close: () => void;
  isClosed: () => boolean;
};
type BrokerOwnership = {
  promise: Promise<BrokerClient>;
};
const brokerOwnersKey = Symbol.for("suri.model-chain.fd-broker-owners");
const brokerOwners = (() => {
  const owner = process as typeof process & {
    [brokerOwnersKey]?: Map<number, BrokerOwnership>;
  };
  return (owner[brokerOwnersKey] ??= new Map<number, BrokerOwnership>());
})();
let startupBroker: BrokerClient | undefined;

async function createFdBroker(fd: number): Promise<BrokerClient> {
  let socket: Socket;
  try {
    socket = new Socket({ fd, readable: true, writable: true });
  } catch {
    throw new Error("SURI_CHAIN_CAPABILITY_UNAVAILABLE");
  }
  const line = await new Promise<string>((resolve, reject) => {
    let buffer = "";
    let settled = false;
    const finish = (error?: Error, value?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("end", onEnd);
      if (error) {
        socket.destroy();
        reject(error);
      } else resolve(value!);
    };
    const timer = setTimeout(
      () => finish(new Error("SURI_CHAIN_CAPABILITY_UNAVAILABLE")),
      2000,
    );
    const onError = () =>
      finish(new Error("SURI_CHAIN_CAPABILITY_UNAVAILABLE"));
    const onEnd = () => finish(new Error("SURI_CHAIN_CAPABILITY_UNAVAILABLE"));
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      if (Buffer.byteLength(buffer) > 1024) {
        finish(new Error("SURI_CHAIN_CAPABILITY_INVALID"));
        return;
      }
      const index = buffer.indexOf("\n");
      if (index >= 0) finish(undefined, buffer.slice(0, index));
    };
    socket.on("data", onData);
    socket.once("error", onError);
    socket.once("end", onEnd);
  });
  let parsed: ReturnType<typeof parseBrokerHandshake>;
  try {
    parsed = parseBrokerHandshake(line);
  } catch {
    socket.destroy();
    throw new Error("SURI_CHAIN_CAPABILITY_INVALID");
  }
  let requestCounter = 0;
  let responseCounter = 0;
  let buffer = "";
  const pending: Array<{
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }> = [];
  socket.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    if (Buffer.byteLength(buffer) > 32 * 1024) {
      close(new Error("SURI_CHAIN_CAPABILITY_INVALID"));
      return;
    }
    while (buffer.includes("\n")) {
      const index = buffer.indexOf("\n");
      const responseLine = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      const waiter = pending[0];
      if (!waiter) continue;
      try {
        const payload = verifyBrokerFrame(
          parsed.key,
          parsed.handshake.channelId,
          ++responseCounter,
          responseLine,
        );
        pending.shift();
        clearTimeout(waiter.timer);
        waiter.resolve(payload);
      } catch {
        close(new Error("SURI_CHAIN_CAPABILITY_INVALID"));
        return;
      }
    }
  });
  let closed = false;
  const close = (reason = new Error("SURI_CHAIN_CAPABILITY_UNAVAILABLE")) => {
    if (closed) return;
    closed = true;
    for (const waiter of pending.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(reason);
    }
    destroyBrokerKey(parsed.key);
    socket.destroy();
    brokerOwners.delete(fd);
  };
  socket.once("close", () => close());
  socket.once("error", () => close());
  socket.once("end", () => close());
  return {
    close,
    isClosed: () => closed,
    transport: (packet) =>
      new Promise((resolve, reject) => {
        if (closed) {
          reject(new Error("SURI_CHAIN_CAPABILITY_UNAVAILABLE"));
          return;
        }
        const timer = setTimeout(() => {
          const index = pending.findIndex((waiter) => waiter.timer === timer);
          if (index >= 0) pending.splice(index, 1);
          reject(new Error("SURI_CHAIN_CAPABILITY_UNAVAILABLE"));
          close();
        }, 10_000);
        pending.push({ resolve, reject, timer });
        let frame;
        try {
          frame = signBrokerFrame(
            parsed.key,
            parsed.handshake.channelId,
            ++requestCounter,
            packet,
          );
        } catch {
          pending.pop();
          clearTimeout(timer);
          reject(new Error("SURI_CHAIN_CAPABILITY_INVALID"));
          return;
        }
        socket.write(`${JSON.stringify(frame)}\n`, (error) => {
          if (error) close();
        });
      }),
  };
}

export async function consumeFdBrokerHandshake(fd = 3): Promise<void> {
  if (startupBroker && !startupBroker.isClosed()) return;
  startupBroker = undefined;
  let ownership = brokerOwners.get(fd);
  if (!ownership) {
    const promise = createFdBroker(fd);
    ownership = { promise };
    brokerOwners.set(fd, ownership);
    // A failed broker startup releases its ownership slot; the awaiting caller below reports the failure.
    void promise.catch(() => {
      if (brokerOwners.get(fd)?.promise === promise) brokerOwners.delete(fd);
    });
  }
  startupBroker = await ownership.promise;
}

export function takeStartupBrokerTransport(): SuriChainTransport {
  if (!startupBroker || startupBroker.isClosed())
    throw new Error("SURI_CHAIN_CAPABILITY_UNAVAILABLE");
  return startupBroker.transport;
}
