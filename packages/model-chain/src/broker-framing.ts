import {
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";

const BROKER_PROTOCOL = "suri-model-chain-broker-v1";
export const MAX_BROKER_FRAME_BYTES = 32 * 1024;
const MAX_BROKER_PAYLOAD_BYTES = 24 * 1024;

type BrokerHandshake = {
  protocol: typeof BROKER_PROTOCOL;
  type: "handshake";
  channelId: string;
  hostGeneration: string;
  key: string;
};

type BrokerFrame = {
  v: 1;
  channelId: string;
  counter: number;
  payload: unknown;
  mac: string;
};

const canonicalBytes = (channelId: string, counter: number, payload: unknown) =>
  Buffer.from(JSON.stringify([1, channelId, counter, payload]), "utf8");

const macFor = (
  key: Buffer,
  channelId: string,
  counter: number,
  payload: unknown,
) =>
  createHmac("sha256", key)
    .update(canonicalBytes(channelId, counter, payload))
    .digest("base64url");

export function createBrokerHandshake(hostGeneration: string): {
  handshake: BrokerHandshake;
  key: Buffer;
} {
  const key = randomBytes(32);
  return {
    key,
    handshake: {
      protocol: BROKER_PROTOCOL,
      type: "handshake",
      channelId: randomUUID(),
      hostGeneration,
      key: key.toString("base64url"),
    },
  };
}

export function parseBrokerHandshake(line: string): {
  handshake: Omit<BrokerHandshake, "key">;
  key: Buffer;
} {
  if (Buffer.byteLength(line) > 1024)
    throw new Error("BROKER_HANDSHAKE_INVALID");
  const value = JSON.parse(line) as BrokerHandshake;
  const key = Buffer.from(String(value?.key ?? ""), "base64url");
  if (
    value?.protocol !== BROKER_PROTOCOL ||
    value.type !== "handshake" ||
    !/^[0-9a-f-]{36}$/i.test(value.channelId) ||
    !/^[0-9a-f-]{36}$/i.test(value.hostGeneration) ||
    key.length !== 32
  ) {
    key.fill(0);
    throw new Error("BROKER_HANDSHAKE_INVALID");
  }
  return {
    key,
    handshake: {
      protocol: BROKER_PROTOCOL,
      type: "handshake",
      channelId: value.channelId,
      hostGeneration: value.hostGeneration,
    },
  };
}

export function signBrokerFrame(
  key: Buffer,
  channelId: string,
  counter: number,
  payload: unknown,
): BrokerFrame {
  const payloadBytes = Buffer.byteLength(JSON.stringify(payload));
  if (payloadBytes > MAX_BROKER_PAYLOAD_BYTES)
    throw new Error("BROKER_FRAME_OVERSIZED");
  return {
    v: 1,
    channelId,
    counter,
    payload,
    mac: macFor(key, channelId, counter, payload),
  };
}

export function verifyBrokerFrame(
  key: Buffer,
  expectedChannelId: string,
  expectedCounter: number,
  raw: string,
): unknown {
  if (Buffer.byteLength(raw) > MAX_BROKER_FRAME_BYTES)
    throw new Error("BROKER_FRAME_OVERSIZED");
  const frame = JSON.parse(raw) as BrokerFrame;
  if (
    frame?.v !== 1 ||
    frame.channelId !== expectedChannelId ||
    frame.counter !== expectedCounter ||
    !Number.isSafeInteger(frame.counter) ||
    typeof frame.mac !== "string" ||
    Buffer.byteLength(JSON.stringify(frame.payload)) > MAX_BROKER_PAYLOAD_BYTES
  )
    throw new Error("BROKER_AUTH_REJECTED");
  const supplied = Buffer.from(frame.mac, "base64url");
  const expected = Buffer.from(
    macFor(key, frame.channelId, frame.counter, frame.payload),
    "base64url",
  );
  const valid =
    supplied.length === expected.length && timingSafeEqual(supplied, expected);
  supplied.fill(0);
  expected.fill(0);
  if (!valid) throw new Error("BROKER_AUTH_REJECTED");
  return frame.payload;
}

export function destroyBrokerKey(key: Buffer | undefined) {
  key?.fill(0);
}
