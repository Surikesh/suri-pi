import { describe, it, expect } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  JsonlDecoder,
  PiClient,
  Translator,
  estimateCompactionHistoryTokens,
  requireReviewQueueCapabilities,
  reviewQueueCapabilities,
  rpcResponseTimeout,
} from "../../packages/pi-adapter/src/index.js";
import {
  publicModel,
  initialProjection,
  reduce,
} from "../../packages/protocol/src/index.js";
describe("Pi public stream boundary", () => {
  it("reports review-queue capabilities without inventing writer or reviewer enforcement", () => {
    const capabilities = reviewQueueCapabilities("0.85.1");
    expect(Object.values(capabilities.operations)).toEqual(
      expect.arrayContaining(["capability_unavailable"]),
    );
    expect(
      Object.values(capabilities.operations).every(
        (state) => state === "capability_unavailable",
      ),
    ).toBe(true);
    expect(() =>
      requireReviewQueueCapabilities(capabilities, [
        "durable_cursor",
        "suspend_writer",
      ]),
    ).toThrow(/durable_cursor, suspend_writer/);
    expect(reviewQueueCapabilities("0.84.4").operations.context_usage).toBe(
      "capability_unavailable",
    );
  });

  it("allows compaction to outlive the default RPC timeout", () => {
    expect(rpcResponseTimeout("compact")).toBe(300_000);
    expect(rpcResponseTimeout("get_state")).toBe(10_000);
  });

  it("estimates the history tokens used by Pi compaction", () => {
    expect(
      estimateCompactionHistoryTokens([
        { role: "user", content: "12345678" },
        {
          role: "assistant",
          content: [
            { type: "text", text: "1234" },
            { type: "thinking", thinking: "1234" },
            { type: "toolCall", name: "x", arguments: { a: 1 } },
          ],
        },
        { role: "toolResult", content: [{ type: "image", data: "ignored" }] },
      ]),
    ).toBe(1206);
  });

  it("accepts extension persistence after web_search without exposing state or warning", () => {
    let state = initialProjection();
    let seq = 0;
    const events: any[] = [];
    const translator = new Translator((type, payload) => {
      events.push({ type, payload });
      state = reduce(state, { type, payload, seq: ++seq });
    });
    translator.record({ type: "agent_start" });
    translator.record({
      type: "tool_execution_end",
      toolCallId: "search-1",
      toolName: "web_search",
      result: { content: [{ type: "text", text: "Search complete" }] },
      isError: false,
    });
    translator.record({
      type: "entry_appended",
      entry: {
        type: "custom",
        customType: "search-state",
        data: "synthetic-secret",
      },
    });
    translator.record({ type: "agent_end" });
    translator.record({ type: "agent_settled" });
    expect(state.notices).toEqual([]);
    expect(state.outcome).toBe("completed");
    expect(state.tools["search-1"].phase).toBe("completed");
    expect(JSON.stringify(events)).not.toContain("synthetic-secret");
    translator.record({ type: "future_unknown_event" });
    expect(state.notices).toHaveLength(1);
  });
  it("recognizes the real thinking-change notification without a warning", () => {
    const events: any[] = [];
    const translator = new Translator((type, payload) => {
      events.push({ type, payload });
    });
    translator.record({ type: "thinking_level_changed", level: "medium" });
    expect(events).toEqual([
      { type: "runtime.thinking", payload: { level: "medium" } },
    ]);
  });
  it("preserves split UTF-8 and Unicode separators with LF/CRLF/EOF", () => {
    const records: any[] = [];
    const errors: string[] = [];
    const decoder = new JsonlDecoder(
      (r) => records.push(r),
      (e) => errors.push(e),
    );
    const bytes = Buffer.from(
      '{"type":"text","text":"Привет🙂\u2028\u2029"}\r\n{"type":"end"}',
    );
    for (const b of bytes) decoder.feed(Buffer.from([b]));
    decoder.end();
    expect(errors).toEqual([]);
    expect(records).toHaveLength(2);
    expect(records[0].text).toBe("Привет🙂\u2028\u2029");
  });
  it("rejects malformed and oversized records", () => {
    const errors: string[] = [];
    const d = new JsonlDecoder(
      () => {},
      (e) => errors.push(e),
      30,
    );
    d.feed(
      Buffer.from(
        "bad\n" + JSON.stringify({ type: "text", text: "x".repeat(50) }) + "\n",
      ),
    );
    expect(errors).toEqual(["MALFORMED_RPC", "LIMIT_EXCEEDED"]);
  });
  it("keeps the previous response usage while the next response is streaming", () => {
    let state = initialProjection();
    let seq = 0;
    const translator = new Translator((type, payload) => {
      state = reduce(state, { type, payload, seq: ++seq });
    });
    state = reduce(state, {
      type: "usage.updated",
      payload: {
        input: 10_000,
        output: 500,
        cacheRead: 8_000,
        cacheWrite: 200,
        cost: 0.12,
      },
      seq: ++seq,
    });

    translator.record({ type: "agent_start" });
    translator.record({
      type: "message_start",
      message: {
        role: "assistant",
        content: [],
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          cost: { total: 0 },
        },
      },
    });
    expect(state.usage).toEqual({
      input: 10_000,
      output: 500,
      cacheRead: 8_000,
      cacheWrite: 200,
      cost: 0.12,
    });

    translator.record({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "done" }],
        stopReason: "stop",
        usage: {
          input: 12_000,
          output: 700,
          cacheRead: 9_000,
          cacheWrite: 300,
          cost: { total: 0.2 },
        },
      },
    });
    expect(state.usage).toEqual({
      input: 12_000,
      output: 700,
      cacheRead: 9_000,
      cacheWrite: 300,
      cost: 0.2,
    });
  });

  it("agent_end is intermediate and streamed deltas become a stable final message", () => {
    let state = initialProjection();
    let seq = 0;
    const t = new Translator((type, payload) => {
      state = reduce(state, { type, payload, seq: ++seq });
    });
    t.record({ type: "agent_start" });
    t.record({
      type: "message_start",
      message: { role: "assistant", content: [] },
    });
    t.record({
      type: "message_update",
      assistantMessageEvent: { type: "text_start", contentIndex: 0 },
    });
    t.record({
      type: "message_update",
      assistantMessageEvent: {
        type: "text_delta",
        contentIndex: 0,
        delta: "hello",
      },
    });
    expect(state.messages[0].blocks[0].text).toBe("hello");
    t.record({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "hello" }],
        stopReason: "stop",
      },
    });
    t.record({ type: "agent_end" });
    expect(state.phase).toBe("running");
    t.record({ type: "agent_settled" });
    expect(state.outcome).toBe("completed");
    expect(state.messages).toHaveLength(1);
  });
  it.each([1_000_000_000, -1, 17, 1.5])(
    "rejects out-of-range content index %s as a malformed delta without allocating",
    (contentIndex) => {
      const events: any[] = [];
      const t = new Translator((type, p) => events.push({ type, ...p }));
      t.record({
        type: "message_start",
        message: { role: "assistant", content: [] },
      });
      events.length = 0;
      t.record({
        type: "message_update",
        assistantMessageEvent: { type: "text_start", contentIndex },
      });
      expect(events.map((e) => e.type)).toEqual(["notice"]);
      expect(events[0]).toMatchObject({ code: "MALFORMED_DELTA" });
    },
  );
  it("accepts a small gap in content indexes", () => {
    const events: any[] = [];
    const t = new Translator((type, p) => events.push({ type, ...p }));
    t.record({
      type: "message_start",
      message: { role: "assistant", content: [] },
    });
    t.record({
      type: "message_update",
      assistantMessageEvent: { type: "text_start", contentIndex: 2 },
    });
    expect(events.at(-1)).toMatchObject({ type: "message.upsert" });
  });
  it("removes terminal color controls from streamed and final assistant text", () => {
    const events: any[] = [];
    const t = new Translator((type, p) => events.push({ type, ...p }));
    t.record({
      type: "message_start",
      message: { role: "assistant", content: [] },
    });
    t.record({
      type: "message_update",
      assistantMessageEvent: { type: "text_start", contentIndex: 0 },
    });
    t.record({
      type: "message_update",
      assistantMessageEvent: {
        type: "text_delta",
        contentIndex: 0,
        delta: "\u001b[38;2;118;118;118mtools: quiet\u001b[39m",
      },
    });
    expect(events.at(-1).blocks[0].text).toBe("tools: quiet");
    t.record({
      type: "message_end",
      message: {
        role: "assistant",
        content: [
          {
            type: "text",
            text: "Hello \u001b[31mred\u001b[0m world",
          },
        ],
      },
    });
    expect(events.at(-1).blocks[0].text).toBe("Hello red world");
  });
  it.each([
    ["error", "failed"],
    ["aborted", "cancelled"],
    ["length", "limitReached"],
  ])("preserves terminal reason %s", (stopReason, outcome) => {
    const events: any[] = [];
    const t = new Translator((type, p) => events.push({ type, ...p }));
    t.record({
      type: "message_end",
      message: { role: "assistant", content: [], stopReason },
    });
    t.record({ type: "agent_settled" });
    expect(events.at(-1).outcome).toBe(outcome);
  });
  it("whitelists model fields and never projects provider headers", () => {
    const m = publicModel({
      id: "safe",
      provider: "fixture",
      headers: { Authorization: "synthetic-secret" },
      apiKey: "synthetic-secret",
      name: "Fixture",
    });
    expect(JSON.stringify(m)).not.toContain("synthetic-secret");
    expect(Object.keys(m)).not.toContain("headers");
  });
  it("does not let corrupted streams claim success", () => {
    const events: any[] = [];
    const t = new Translator((type, p) => events.push({ type, ...p }));
    t.fault("MALFORMED_RPC");
    t.record({ type: "agent_settled" });
    expect(events.at(-1).outcome).toBe("failed");
  });
  it.each([
    [{}, "completed"],
    [{ aborted: true }, "cancelled"],
    [{ errorMessage: "summary failed" }, "failed"],
    [
      {
        errorMessage:
          "Compaction failed: Nothing to compact (session too small)",
      },
      "completed",
    ],
  ])("settles manual compaction back to idle", (ending, outcome) => {
    let state = initialProjection();
    let seq = 0;
    const translator = new Translator((type, payload) => {
      state = reduce(state, { type, payload, seq: ++seq });
    });
    translator.record({ type: "compaction_start", reason: "manual" });
    expect(state.phase).toBe("compacting");
    translator.record({
      type: "compaction_end",
      reason: "manual",
      ...ending,
    });
    expect(state.phase).toBe("idle");
    expect(state.outcome).toBe(outcome);
    expect(state.notices.at(-1)?.severity).toBe(
      outcome === "failed" ? "error" : "info",
    );
    if (outcome === "completed" && "errorMessage" in ending)
      expect(state.notices.at(-1)?.text).toContain(
        "not have enough older history",
      );
  });

  it("treats Pi's too-small compact rejection as a successful no-op", async () => {
    const dir = await mkdtemp(join(tmpdir(), "suri-compact-noop-"));
    const executable = join(dir, "pi-fixture.mjs");
    await writeFile(
      executable,
      `#!/usr/bin/env node
import {createInterface} from "node:readline";
const emit = value => process.stdout.write(JSON.stringify(value) + "\\n");
createInterface({input: process.stdin}).on("line", line => {
  const command = JSON.parse(line);
  emit({type:"compaction_start", reason:"manual"});
  emit({type:"compaction_end", reason:"manual", errorMessage:"Compaction failed: Nothing to compact (session too small)", aborted:false, willRetry:false});
  emit({type:"response", id:command.id, command:command.type, success:false, error:"Nothing to compact (session too small)"});
});
`,
      { mode: 0o755 },
    );
    const events: Array<{ type: string; payload: any }> = [];
    const pi = new PiClient(
      { executable, cwd: dir, sessionDir: dir },
      (type, payload) => events.push({ type, payload }),
    );
    try {
      await expect(pi.request("compact")).resolves.toEqual({
        compacted: false,
        reason: "session-too-small",
      });
      expect(events.at(-1)).toEqual({
        type: "run.state",
        payload: { phase: "idle", outcome: "completed" },
      });
      expect(events.find((event) => event.type === "notice")?.payload).toEqual({
        code: "compaction_end",
        severity: "info",
        text: "The session does not have enough older history to compact yet.",
      });
    } finally {
      pi.close();
      await new Promise((resolve) => setTimeout(resolve, 30));
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("never exposes arbitrary upstream compaction error text", async () => {
    const dir = await mkdtemp(join(tmpdir(), "suri-compact-redaction-"));
    const executable = join(dir, "pi-fixture.mjs");
    const sentinel = "synthetic-token-SHOULD-NOT-ESCAPE";
    await writeFile(
      executable,
      `#!/usr/bin/env node
import {createInterface} from "node:readline";
const emit = value => process.stdout.write(JSON.stringify(value) + "\\n");
createInterface({input: process.stdin}).on("line", line => {
  const command = JSON.parse(line);
  emit({type:"compaction_end", reason:"manual", errorMessage:${JSON.stringify(sentinel)}, aborted:false});
  emit({type:"response", id:command.id, command:command.type, success:false, error:${JSON.stringify(sentinel)}});
});
`,
      { mode: 0o755 },
    );
    const events: unknown[] = [];
    const pi = new PiClient(
      { executable, cwd: dir, sessionDir: dir },
      (type, payload) => events.push({ type, payload }),
    );
    try {
      let rejected: unknown;
      try {
        await pi.request("compact");
      } catch (error) {
        rejected = error;
      }
      expect(JSON.stringify({ rejected, events })).not.toContain(sentinel);
      expect(rejected).toMatchObject({ code: "UPSTREAM_REJECTED" });
      expect(events).toContainEqual({
        type: "notice",
        payload: {
          code: "compaction_end",
          severity: "error",
          text: "Runtime recovery reported an error.",
        },
      });
    } finally {
      pi.close();
      await new Promise((resolve) => setTimeout(resolve, 30));
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("keeps only the latest notice for the same recovery event", () => {
    let state = initialProjection();
    state = reduce(state, {
      type: "notice",
      seq: 1,
      payload: {
        code: "compaction_end",
        severity: "error",
        text: "Previous compaction error",
      },
    });
    state = reduce(state, {
      type: "notice",
      seq: 2,
      payload: {
        code: "compaction_end",
        severity: "info",
        text: "Current compaction result",
      },
    });
    expect(state.notices).toEqual([
      {
        code: "compaction_end",
        severity: "info",
        text: "Current compaction result",
        eventSeq: 2,
      },
    ]);
  });
});

it("reports a timed-out side effect as indeterminate without redispatch", async () => {
  const dir = await mkdtemp(join(tmpdir(), "suri-indeterminate-"));
  const executable = join(dir, "pi-fixture.mjs");
  await writeFile(
    executable,
    `#!/usr/bin/env node
import {createInterface} from "node:readline";
const emit = value => process.stdout.write(JSON.stringify(value) + "\\n");
emit({type: "agent_start"});
createInterface({input: process.stdin}).on("line", () => emit({type: "agent_start"}));
`,
    { mode: 0o755 },
  );
  const events: string[] = [];
  let markReady!: () => void;
  const ready = new Promise<void>((resolve) => {
    markReady = resolve;
  });
  const pi = new PiClient({ executable, cwd: dir, sessionDir: dir }, (type) => {
    events.push(type);
    if (events.length === 1) markReady();
  });
  try {
    await ready;
    await expect(
      pi.request("set_model", { provider: "fixture", modelId: "slow" }, 1_000),
    ).rejects.toMatchObject({ code: "INDETERMINATE" });
    expect(events).toEqual(["run.state", "run.state"]);
  } finally {
    pi.close();
    await new Promise((resolve) => setTimeout(resolve, 30));
    await rm(dir, { recursive: true, force: true });
  }
});

it("waits for an owned runtime exit and bounds a stalled child", async () => {
  const dir = await mkdtemp(join(tmpdir(), "suri-runtime-exit-"));
  const executable = join(dir, "pi-fixture.mjs");
  await writeFile(
    executable,
    `#!/usr/bin/env node
process.stdin.resume();
process.stderr.write("fixture-ready\\n");
process.stdin.on("end", () => setTimeout(() => process.exit(0), 80));
setInterval(() => {}, 1000);
`,
    { mode: 0o755 },
  );
  const delayed = new PiClient(
    { executable, cwd: dir, sessionDir: dir },
    () => {},
  );
  // The grace period measures shutdown after the fixture is listening to stdin,
  // not a contended child-process startup under the parallel unit suite.
  await new Promise<void>((resolve) =>
    delayed.child.stderr.once("data", () => resolve()),
  );
  const started = Date.now();
  await delayed.closeAndWait(1000);
  expect(Date.now() - started).toBeGreaterThanOrEqual(50);

  await writeFile(
    executable,
    `#!/usr/bin/env node
process.stdin.resume();
setInterval(() => {}, 1000);
`,
    { mode: 0o755 },
  );
  const stalled = new PiClient(
    { executable, cwd: dir, sessionDir: dir },
    () => {},
  );
  await expect(stalled.closeAndWait(20)).rejects.toMatchObject({
    code: "RUNTIME_EXIT_TIMEOUT",
  });
  stalled.forceStop();
  await stalled.exited;
  await rm(dir, { recursive: true, force: true });
});

it("a requested abort stays cancelled when provider reports error while unwinding", () => {
  let last: any;
  const t = new Translator((type, p) => {
    if (type === "run.state") last = p;
  });
  t.record({ type: "agent_start" });
  t.cancelling();
  t.record({
    type: "message_end",
    message: { role: "assistant", content: [], stopReason: "error" },
  });
  t.record({ type: "agent_settled" });
  expect(last.outcome).toBe("cancelled");
});
