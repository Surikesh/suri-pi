import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { IncomingMessage } from "node:http";
import type { WebSocket } from "ws";
import { createTransport } from "../../apps/host/src/host-transport.js";

const EIGHT_HOURS = 8 * 3600000;
const req = (secret: string) =>
  ({ headers: { cookie: `suri_1=${secret}` } }) as IncomingMessage;
const fake = () => {
  const socket = { close: vi.fn() };
  return socket as typeof socket & WebSocket;
};
const setup = () => {
  const transport = createTransport({ cookieName: () => "suri_1" });
  const entry = (id: string, restartOperationId?: string) => ({
    id,
    csrf: id,
    expires: Date.now() + EIGHT_HOURS,
    restartOperationId,
  });
  return { transport, entry };
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
});
afterEach(() => {
  vi.useRealTimers();
});

it("revocation closes all sockets bound to the secret but not sibling secrets", () => {
  const { transport, entry } = setup();
  transport.addClient("a1", entry("a", "op"));
  transport.addClient("a2", entry("a")); // same clientId, not restart-bound
  transport.addClient("c1", entry("c", "other"));
  const [s1, s2, sibling, other] = [fake(), fake(), fake(), fake()];
  transport.trackWs(s1, req("a1"));
  transport.trackWs(s2, req("a1"));
  transport.trackWs(sibling, req("a2"));
  transport.trackWs(other, req("c1"));
  expect(vi.getTimerCount()).toBe(3);
  transport.revokeRestartOperation("op");
  expect(s1.close).toHaveBeenCalledWith(1008);
  expect(s2.close).toHaveBeenCalledWith(1008);
  expect(sibling.close).not.toHaveBeenCalled();
  expect(other.close).not.toHaveBeenCalled();
  expect(transport.live(s1)).toBe(false);
  expect(transport.live(sibling)).toBe(true);
  expect(() => transport.auth(req("a1"))).toThrow();
  // Revoked secret's timer is gone; closing the sockets clears the rest.
  expect(vi.getTimerCount()).toBe(2);
  for (const s of [s1, s2, sibling, other]) transport.untrackWs(s);
  expect(vi.getTimerCount()).toBe(0);
});

it("expiry closes only the expired secret at the strict boundary and live() never renews", () => {
  const { transport, entry } = setup();
  transport.addClient("a", entry("a"));
  transport.addClient("b", entry("b"));
  const [a, b] = [fake(), fake()];
  transport.trackWs(a, req("a"));
  transport.trackWs(b, req("b"));
  vi.advanceTimersByTime(EIGHT_HOURS - 1);
  transport.auth(req("a")); // renew only a
  expect(transport.peek(req("b")).id).toBe("b");
  vi.advanceTimersByTime(1); // now === expires: still valid
  expect(b.close).not.toHaveBeenCalled();
  expect(transport.live(b)).toBe(true);
  vi.advanceTimersByTime(1); // now > expires
  expect(b.close).toHaveBeenCalledWith(1008);
  expect(a.close).not.toHaveBeenCalled();
  expect(transport.live(b)).toBe(false);
  expect(transport.live(a)).toBe(true);
  expect(vi.getTimerCount()).toBe(1); // only a's rescheduled timer remains
  transport.untrackWs(a);
  transport.untrackWs(b);
  expect(vi.getTimerCount()).toBe(0);
});
