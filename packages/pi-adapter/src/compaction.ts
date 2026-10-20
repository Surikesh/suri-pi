import type { Data } from "../../protocol/src/index.js";

export const isSessionTooSmallForCompaction = (value: unknown) =>
  typeof value === "string" &&
  value.includes("Nothing to compact (session too small)");

export const rpcResponseTimeout = (type: string) =>
  type === "compact" ? 5 * 60_000 : 10_000;

function textAndImageChars(value: unknown) {
  if (typeof value === "string") return value.length;
  if (!Array.isArray(value)) return 0;
  return value.reduce((total, block: Data) => {
    if (block.type === "text" && typeof block.text === "string")
      return total + block.text.length;
    if (block.type === "image") return total + 4_800;
    return total;
  }, 0);
}

export function estimateCompactionHistoryTokens(value: unknown) {
  if (!Array.isArray(value)) return null;
  return value.reduce((total, message: Data) => {
    let chars = 0;
    if (["user", "custom", "toolResult"].includes(message.role))
      chars = textAndImageChars(message.content);
    else if (message.role === "assistant" && Array.isArray(message.content))
      for (const block of message.content as Data[]) {
        if (block.type === "text" && typeof block.text === "string")
          chars += block.text.length;
        else if (
          block.type === "thinking" &&
          typeof block.thinking === "string"
        )
          chars += block.thinking.length;
        else if (block.type === "toolCall")
          chars +=
            String(block.name ?? "").length +
            JSON.stringify(block.arguments ?? {}).length;
      }
    else if (message.role === "bashExecution")
      chars =
        String(message.command ?? "").length +
        String(message.output ?? "").length;
    else if (["branchSummary", "compactionSummary"].includes(message.role))
      chars = String(message.summary ?? "").length;
    return total + Math.ceil(chars / 4);
  }, 0);
}
