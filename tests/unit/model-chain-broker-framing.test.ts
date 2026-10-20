import { describe, expect, it } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import {
  createBrokerHandshake,
  destroyBrokerKey,
  MAX_BROKER_FRAME_BYTES,
  signBrokerFrame,
  verifyBrokerFrame,
} from "../../packages/model-chain/src/broker-framing.js";

describe("Model Chain broker framing", () => {
  it("accepts a valid authenticated frame exactly at its expected counter", () => {
    const broker = createBrokerHandshake(randomUUID());
    const frame = signBrokerFrame(broker.key, broker.handshake.channelId, 1, {
      type: "host.get",
    });
    expect(
      verifyBrokerFrame(
        broker.key,
        broker.handshake.channelId,
        1,
        JSON.stringify(frame),
      ),
    ).toEqual({ type: "host.get" });
    expect(() =>
      verifyBrokerFrame(
        broker.key,
        broker.handshake.channelId,
        2,
        JSON.stringify(frame),
      ),
    ).toThrow("BROKER_AUTH_REJECTED");
  });

  it("rejects missing/invalid MAC, payload tampering, wrong channel, replay and order", () => {
    const broker = createBrokerHandshake(randomUUID());
    const frame = signBrokerFrame(broker.key, broker.handshake.channelId, 2, {
      value: "original",
    });
    for (const candidate of [
      { ...frame, mac: "" },
      { ...frame, mac: randomBytes(32).toString("base64url") },
      { ...frame, payload: { value: "altered" } },
      { ...frame, channelId: randomUUID() },
      { ...frame, counter: 1 },
      { ...frame, counter: 3 },
    ])
      expect(() =>
        verifyBrokerFrame(
          broker.key,
          broker.handshake.channelId,
          2,
          JSON.stringify(candidate),
        ),
      ).toThrow("BROKER_AUTH_REJECTED");
  });

  it("rejects an oversized frame before authentication and zeroes released keys", () => {
    const broker = createBrokerHandshake(randomUUID());
    expect(() =>
      verifyBrokerFrame(
        broker.key,
        broker.handshake.channelId,
        1,
        "x".repeat(MAX_BROKER_FRAME_BYTES + 1),
      ),
    ).toThrow("BROKER_FRAME_OVERSIZED");
    destroyBrokerKey(broker.key);
    expect([...broker.key]).toEqual(new Array(32).fill(0));
  });
});
