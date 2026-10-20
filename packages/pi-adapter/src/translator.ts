import { randomUUID, createHash } from "node:crypto";
import { content, displayText } from "./content.js";
import { isSessionTooSmallForCompaction } from "./compaction.js";
import type { Block, Data } from "../../protocol/src/index.js";

/** Pi emits content indexes sequentially; tolerate a small gap, reject the rest. */
const MAX_CONTENT_INDEX_GAP = 16;

export class Translator {
  private messageId = "";
  private blocks: Block[] = [];
  private revision = 0;
  private stopReason = "";
  private cancel = false;
  private degraded = false;
  private imageIds = new Map<string, string>();
  private image = (data: string, mime: string) => {
    const hash = createHash("sha256").update(data).digest("hex");
    const old = this.imageIds.get(hash);
    if (old) return old;
    const id = randomUUID();
    this.imageIds.set(hash, id);
    this.emit("artifact.inline", { id, data, mime });
    return id;
  };
  constructor(private emit: (type: string, p: Data) => void) {}
  cancelling() {
    this.cancel = true;
  }
  record(r: Data) {
    switch (r.type) {
      case "agent_start":
        this.stopReason = "";
        this.cancel = false;
        this.emit("run.state", { phase: "running" });
        break;
      case "agent_end":
        break;
      case "agent_settled":
        this.emit("run.state", {
          phase: this.degraded ? "failed" : "idle",
          outcome: this.degraded
            ? "failed"
            : this.cancel || this.stopReason === "aborted"
              ? "cancelled"
              : this.stopReason === "error"
                ? "failed"
                : this.stopReason === "length"
                  ? "limitReached"
                  : "completed",
        });
        break;
      case "turn_start":
      case "turn_end":
        this.emit("turn.state", {
          phase: r.type === "turn_start" ? "running" : "ended",
        });
        break;
      case "message_start":
        this.messageId = randomUUID();
        this.revision = 0;
        this.blocks = content(r.message?.content, this.messageId, this.image);
        this.message(r.message, false);
        break;
      case "message_update": {
        const d = r.assistantMessageEvent;
        if (
          !d ||
          !Number.isInteger(d.contentIndex) ||
          d.contentIndex < 0 ||
          d.contentIndex > this.blocks.length + MAX_CONTENT_INDEX_GAP
        ) {
          this.fault("MALFORMED_DELTA");
          break;
        }
        const i = d.contentIndex;
        const id = `${this.messageId}:${i}`;
        if (d.type === "text_start" || d.type === "thinking_start")
          this.blocks[i] = {
            id,
            kind: d.type === "text_start" ? "text" : "thinking",
            text: "",
          };
        else if (d.type === "text_delta" || d.type === "thinking_delta") {
          this.blocks[i] ??= {
            id,
            kind: d.type === "text_delta" ? "text" : "thinking",
            text: "",
          };
          this.blocks[i] = {
            ...this.blocks[i],
            text: (this.blocks[i].text ?? "") + displayText(d.delta),
          };
        } else if (d.type === "toolcall_start")
          this.blocks[i] = {
            id,
            kind: "toolCall",
            callId: d.id,
            name: d.toolName,
            arguments: {},
          };
        else if (d.type === "toolcall_end")
          this.blocks[i] = {
            id,
            kind: "toolCall",
            callId: d.toolCall?.id,
            name: d.toolCall?.name,
            arguments: d.toolCall?.arguments ?? {},
          };
        this.emit("message.upsert", {
          messageId: this.messageId,
          role: "assistant",
          blocks: this.blocks.filter(Boolean).map((b) => ({ ...b })),
          revision: ++this.revision,
          final: false,
        });
        break;
      }
      case "message_end":
        this.message(r.message, true);
        if (r.message?.role === "assistant")
          this.stopReason = r.message.stopReason ?? "";
        break;
      case "tool_execution_start":
      case "tool_execution_update":
      case "tool_execution_end":
        this.emit("tool.state", {
          callId: r.toolCallId,
          name: r.toolName,
          phase: r.type.endsWith("start")
            ? "running"
            : r.type.endsWith("update")
              ? "running"
              : r.isError
                ? "failed"
                : "completed",
          arguments: r.args ?? {},
          blocks: content(
            (r.result ?? r.partialResult)?.content,
            `tool:${r.toolCallId}`,
            this.image,
          ),
        });
        break;
      case "queue_update":
        this.emit("queue.state", {
          items: [
            ...(r.steering ?? []).map((x: Data) => ({
              text: typeof x === "string" ? x : x.message,
              mode: "steer",
            })),
            ...(r.followUp ?? []).map((x: Data) => ({
              text: typeof x === "string" ? x : x.message,
              mode: "followUp",
            })),
          ],
        });
        break;
      case "auto_compaction_start":
      case "compaction_start":
        this.emit("run.state", { phase: "compacting" });
        break;
      case "auto_retry_start":
        this.emit("run.state", { phase: "retrying" });
        break;
      case "auto_compaction_end":
      case "compaction_end":
      case "auto_retry_end": {
        const recoveryError = r.errorMessage ?? r.error;
        const sessionTooSmall =
          r.type === "compaction_end" &&
          r.reason === "manual" &&
          isSessionTooSmallForCompaction(recoveryError);
        this.emit("notice", {
          code: r.type,
          severity: recoveryError && !sessionTooSmall ? "error" : "info",
          text: sessionTooSmall
            ? "The session does not have enough older history to compact yet."
            : recoveryError
              ? "Runtime recovery reported an error."
              : "Runtime recovery updated.",
        });
        if (r.type === "compaction_end" && r.reason === "manual")
          this.emit("run.state", {
            phase: "idle",
            outcome:
              recoveryError && !sessionTooSmall
                ? "failed"
                : r.aborted
                  ? "cancelled"
                  : "completed",
          });
        break;
      }
      case "extension_ui_request":
        this.emit("extension.request", r);
        break;
      case "extension_error":
        this.emit("notice", {
          severity: "error",
          code: "EXTENSION_ERROR",
          text: "A Pi extension reported an error.",
        });
        break;
      case "thinking_level_changed":
        // Public Pi 0.85.1 notification; the host persists the command result.
        this.emit("runtime.thinking", { level: r.level });
        break;
      case "entry_appended":
        // Pi has already persisted extension state via appendEntry. It is not
        // a chat message or an error; keep its private data inside Pi storage.
        break;
      case "response":
        break;
      default:
        this.emit("adapter.unknown", {
          type: typeof r.type === "string" ? r.type.slice(0, 80) : "unknown",
          text: "An unsupported runtime event was received.",
        });
    }
  }
  fault(code: string) {
    this.degraded = true;
    this.emit("notice", {
      severity: "error",
      code,
      text: "The runtime stream is degraded; completion cannot be verified.",
    });
  }
  private message(m: Data, final: boolean) {
    if (!m || typeof m.role !== "string") {
      this.fault("MALFORMED_MESSAGE");
      return;
    }
    if (!this.messageId) this.messageId = randomUUID();
    this.emit("message.upsert", {
      messageId: this.messageId,
      role: m.role,
      blocks: content(m.content, this.messageId, this.image),
      revision: ++this.revision,
      final,
    });
    if (final && m.usage)
      this.emit("usage.updated", {
        input: m.usage.input,
        output: m.usage.output,
        cacheRead: m.usage.cacheRead,
        cacheWrite: m.usage.cacheWrite,
        cost:
          typeof m.usage.cost?.total === "number"
            ? m.usage.cost.total
            : undefined,
      });
  }
}
