import { describe, expect, it, vi } from "vitest";
import {
  CodexUsageReader,
  parseCodexWeeklyUsage,
} from "../../apps/host/src/codex-usage.js";

const token = (account = "account-1") => {
  const encode = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none" })}.${encode({
    "https://api.openai.com/auth": { chatgpt_account_id: account },
  })}.signature`;
};

describe("Codex weekly usage", () => {
  it("selects the seven-day window and converts used to remaining", () => {
    expect(
      parseCodexWeeklyUsage({
        rate_limit: {
          primary_window: {
            used_percent: 12,
            limit_window_seconds: 18_000,
          },
          secondary_window: {
            used_percent: 37.4,
            limit_window_seconds: 604_800,
            reset_at: 2_000_000_000,
          },
        },
      }),
    ).toEqual({
      available: true,
      usedPercent: 37.4,
      remainingPercent: 62.6,
      windowSeconds: 604_800,
      resetsAt: "2033-05-18T03:33:20.000Z",
    });
  });

  it("reads with the Pi-managed credential and caches only public usage", async () => {
    const fetch = vi.fn(
      async (_url: string | URL | Request, init?: RequestInit) => {
        expect(new Headers(init?.headers).get("ChatGPT-Account-Id")).toBe(
          "account-1",
        );
        expect(new Headers(init?.headers).get("Authorization")).toBe(
          `Bearer ${token()}`,
        );
        return new Response(
          JSON.stringify({
            rate_limit: {
              primary_window: {
                used_percent: 25,
                limit_window_seconds: 604_800,
              },
            },
          }),
          { status: 200 },
        );
      },
    );
    const credential = vi.fn(async () => token());
    const reader = new CodexUsageReader("pi", { fetch, credential });

    await expect(reader.read()).resolves.toMatchObject({
      available: true,
      remainingPercent: 75,
    });
    await reader.read();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(credential).toHaveBeenCalledTimes(1);
  });

  it("rejects oversized provider responses without retaining their body", async () => {
    const reader = new CodexUsageReader("pi", {
      credential: async () => token(),
      fetch: async () =>
        new Response("x".repeat(65 * 1024), {
          status: 200,
          headers: { "content-length": String(65 * 1024) },
        }),
    });
    await expect(reader.read()).resolves.toEqual({
      available: false,
      reason: "unavailable",
    });
  });

  it("degrades without exposing credential or provider failures", async () => {
    const reader = new CodexUsageReader("pi", {
      credential: async () => {
        throw Error("secret provider detail");
      },
    });
    await expect(reader.read()).resolves.toEqual({
      available: false,
      reason: "unavailable",
    });
  });
});
