#!/usr/bin/env node
// Synthetic external RPC boundary. No provider SDK, credentials or network.
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
if (process.argv.includes("--version")) {
  console.log("0.85.1");
  process.exit(0);
}
const arg = (name) => process.argv[process.argv.indexOf(name) + 1];
let file = process.argv.includes("--session")
  ? arg("--session")
  : join(arg("--session-dir"), "fixture.jsonl");
let messages = [];
let sessionId = randomUUID();
try {
  const entries = readFileSync(file, "utf8").trim().split("\n").map(JSON.parse);
  sessionId = entries[0].id;
  messages = entries.filter((e) => e.type === "message").map((e) => e.message);
} catch {}
let model = {
  provider: "synthetic",
  id: "fixture-model",
  name: "Fixture model",
  reasoning: true,
};
let thinkingLevel = "medium";
const emit = (value) => process.stdout.write(JSON.stringify(value) + "\n");
createInterface({ input: process.stdin }).on("line", (line) => {
  const c = JSON.parse(line);
  appendFileSync(
    join(process.cwd(), "rpc-calls.jsonl"),
    JSON.stringify(c) + "\n",
  );
  let data = {};
  let success = true;
  switch (c.type) {
    case "get_state":
      data = {
        sessionId,
        sessionFile: file,
        model,
        thinkingLevel,
        isStreaming: false,
      };
      break;
    case "get_messages":
      data = { messages };
      break;
    case "get_available_models":
      data = {
        models: [
          model,
          {
            provider: "synthetic",
            id: "alternate",
            name: "Alternate",
            reasoning: true,
          },
          {
            provider: "synthetic",
            id: "rejected",
            name: "Rejected",
            reasoning: true,
          },
        ],
      };
      break;
    case "get_available_thinking_levels":
      data = { levels: ["off", "low", "medium", "high"] };
      break;
    case "set_model":
      if (c.modelId === "rejected") success = false;
      else
        model = {
          ...model,
          id: c.modelId === "normalized-request" ? "normalized" : c.modelId,
        };
      break;
    case "set_thinking_level":
      thinkingLevel = c.level === "maximum" ? "high" : c.level;
      break;
    case "get_commands":
      data = {
        commands: [
          {
            name: "fixture-template",
            description: "Synthetic prompt template",
            source: "prompt",
          },
          {
            name: "skill:fixture",
            description: "Synthetic skill",
            source: "skill",
          },
          {
            name: "fixture-extension",
            description: "Synthetic immediate extension",
            source: "extension",
          },
        ],
      };
      break;
    case "get_tree":
      data = {
        tree: [
          {
            entry: {
              id: "turn-1",
              type: "message",
              message: {
                role: "user",
                content: [{ type: "text", text: "Forkable synthetic turn" }],
              },
            },
            children: [],
          },
        ],
        leafId: "turn-1",
      };
      break;
    case "get_session_stats":
      data = {
        totalMessages: messages.length,
        toolCalls: 0,
        contextUsage: {
          tokens: 42000,
          contextWindow: 128000,
          percent: 32.8125,
        },
      };
      break;
    case "export_html":
      writeFileSync(c.outputPath, "<!doctype html><p>Synthetic export</p>");
      break;
    case "get_fork_messages":
      data = {
        messages: [{ entryId: "turn-1", text: "Forkable synthetic turn" }],
      };
      break;
    case "clone":
    case "fork":
      sessionId = randomUUID();
      file = join(arg("--session-dir"), `${sessionId}.jsonl`);
      writeFileSync(
        file,
        JSON.stringify({
          type: "session",
          version: 3,
          id: sessionId,
          cwd: process.cwd(),
        }) + "\n",
      );
      data = { text: "Forkable synthetic turn" };
      break;
    case "clear_queue":
      data = { steering: [], followUp: [] };
      break;
    case "prompt":
      if (c.message.includes("REJECT")) success = false;
      break;
  }
  if (c.type === "prompt" && c.message.includes("REJECT_DELAY")) {
    setTimeout(
      () =>
        emit({
          type: "response",
          id: c.id,
          command: c.type,
          success: false,
          data: {},
        }),
      500,
    );
    return;
  }
  if (c.type === "compact") {
    emit({ type: "compaction_start", reason: "manual" });
    emit({
      type: "compaction_end",
      reason: "manual",
      result: { estimatedTokensAfter: 12000 },
      aborted: false,
      willRetry: false,
    });
  }
  emit({ type: "response", id: c.id, command: c.type, success, data });
  if (c.type === "prompt" && success) {
    const user = { role: "user", content: [{ type: "text", text: c.message }] };
    messages.push(user);
    writeFileSync(
      file,
      JSON.stringify({
        type: "session",
        version: 3,
        id: sessionId,
        cwd: process.cwd(),
      }) +
        "\n" +
        messages
          .map((message) => JSON.stringify({ type: "message", message }))
          .join("\n") +
        "\n",
    );
    emit({ type: "agent_start" });
    emit({ type: "message_end", message: user });
    if (c.message.includes("ANSI_STATUS"))
      emit({
        type: "extension_ui_request",
        id: "ansi-status",
        method: "setStatus",
        statusKey: "tools",
        statusText: "\u001b[38;2;118;118;118mtools: quiet\u001b[39m",
      });
    if (!c.message.includes("HOLD")) {
      const assistant = {
        role: "assistant",
        content: [
          {
            type: "text",
            text: "Synthetic reply. Open [hello.txt:2](hello.txt:2).",
          },
        ],
        stopReason: "stop",
      };
      messages.push(assistant);
      emit({
        type: "message_start",
        message: { role: "assistant", content: [] },
      });
      emit({ type: "message_end", message: assistant });
      emit({ type: "agent_end" });
      emit({ type: "agent_settled" });
    }
  }
  if (c.type === "abort") {
    emit({ type: "agent_end" });
    emit({ type: "agent_settled" });
  }
});
