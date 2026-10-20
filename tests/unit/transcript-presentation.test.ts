import { describe, expect, it } from "vitest";
import type { Message } from "../../packages/protocol/src/index.js";
import {
  knownUsageEntries,
  latestKnownUsage,
  mergeTranscriptMessages,
  noticeIdentity,
  transcriptEntries,
} from "../../apps/web/src/domain/presentation.js";

const message = (
  messageId: string,
  role: string,
  revision = 1,
  kind: "text" | "toolCall" = "text",
): Message => ({
  messageId,
  role,
  revision,
  final: true,
  blocks: [
    kind === "text"
      ? { id: `${messageId}-block`, kind, text: messageId }
      : { id: `${messageId}-block`, kind, callId: messageId, name: "read" },
  ],
});

describe("transcript presentation", () => {
  it("accumulates pages, deduplicates stable ids, and keeps the newest revision", () => {
    const merged = mergeTranscriptMessages(
      [message("old", "assistant"), message("tail", "assistant", 1)],
      [message("tail", "assistant", 2), message("live", "user")],
    );
    expect(merged.map((item) => item.messageId)).toEqual([
      "old",
      "tail",
      "live",
    ]);
    expect(merged[1].revision).toBe(2);
  });

  it("groups adjacent tool-only messages across a page boundary but not across a user turn", () => {
    const entries = transcriptEntries(
      mergeTranscriptMessages(
        [message("tool-1", "assistant", 1, "toolCall")],
        [
          message("tool-2", "assistant", 1, "toolCall"),
          message("user", "user"),
          message("tool-3", "assistant", 1, "toolCall"),
        ],
      ),
    );
    expect(entries.map((entry) => entry.kind)).toEqual([
      "activity",
      "message",
      "activity",
    ]);
    expect(entries[0].kind === "activity" && entries[0].messages).toHaveLength(
      2,
    );
  });

  it("uses session and event sequence for notice identity", () => {
    expect(noticeIdentity("session", { code: "recovery", eventSeq: 12 })).toBe(
      "session:12:recovery",
    );
    expect(noticeIdentity("session", { code: "recovery" })).toBeUndefined();
  });

  it("omits unknown usage while retaining real zero values", () => {
    expect(knownUsageEntries({ input: undefined, cacheWrite: 0 })).toEqual([
      { key: "cacheWrite", label: "Cache write", value: 0 },
    ]);
    expect(knownUsageEntries({})).toEqual([]);
  });

  it("keeps the previous completed response when a new turn reports placeholder zeroes", () => {
    const previous = {
      input: 348,
      output: 181,
      cacheRead: 146_048,
      cost: 0.1586,
    };
    expect(
      latestKnownUsage(
        { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
        previous,
      ),
    ).toBe(previous);
    expect(latestKnownUsage({ cacheWrite: 0 })).toEqual({});
    expect(latestKnownUsage({ input: 1, cacheWrite: 0 }, previous)).toEqual({
      input: 1,
      cacheWrite: 0,
    });
  });
});
