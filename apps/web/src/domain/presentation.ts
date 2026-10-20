import type {
  Block,
  Data,
  Message,
} from "../../../../packages/protocol/src/index.js";

export const serviceNames = new Set(["node_modules", "dist", ".build", ".git"]);

export function compactSessionAge(value?: string) {
  const timestamp = Date.parse(value ?? "");
  if (!Number.isFinite(timestamp)) return "";
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (seconds < 60) return "now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo`;
  return `${Math.floor(months / 12)}y`;
}

export function toolSummary(name = "", args: Data = {}) {
  const normalizedName = name.toLowerCase();
  const filePath = args.path ?? args.filePath ?? args.file;
  const value = /^(bash|shell|terminal)$/.test(normalizedName)
    ? (args.description ??
      (typeof args.command === "string"
        ? args.command.split(/\r?\n/, 1)[0]
        : ""))
    : /^(read|write|edit|patch)$/.test(normalizedName)
      ? filePath
      : /^(grep|glob|search|find)$/.test(normalizedName)
        ? (args.query ?? args.pattern)
        : /^(skill|use_skill)$/.test(normalizedName)
          ? (args.skill ?? args.name)
          : (args.description ??
            filePath ??
            args.query ??
            args.pattern ??
            args.command ??
            args.url);
  if (typeof value === "string") return value.replace(/\s+/g, " ").trim();
  const first = Object.values(args).find(
    (candidate) => typeof candidate === "string",
  );
  return typeof first === "string" ? first.replace(/\s+/g, " ").trim() : "";
}

export function shortSummary(value = "") {
  return value
    .replace(/^\s*(?:#{1,6}|[-+*>])\s+/, "")
    .replace(/\*\*|__|~~|`/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
export function tokenCount(value: number) {
  if (value < 1000) return String(value);
  const scaled = value / 1000;
  return `${scaled >= 100 || Number.isInteger(scaled) ? scaled.toFixed(0) : scaled.toFixed(1)}K`;
}
export function toolLabel(name = "Tool") {
  const labels: Record<string, string> = {
    bash: "Bash",
    edit: "Edit",
    glob: "Glob",
    grep: "Search",
    read: "Read",
    search: "Search",
    skill: "Skill",
    use_skill: "Skill",
    write: "Write",
  };
  const normalized = name.trim();
  if (!normalized) return "Tool";
  return (
    labels[normalized.toLowerCase()] ??
    normalized
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .replace(/[_:/.\-]+/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/\b\w/g, (letter) => letter.toUpperCase())
  );
}
export function toolIcon(name = ""): import("../icons.js").ActivityIconName {
  if (/^read$/i.test(name)) return "read";
  if (/^(write|edit)$/i.test(name)) return "write";
  if (/^(glob|grep|search)$/i.test(name)) return "search";
  if (/^(bash|shell|terminal)$/i.test(name)) return "terminal";
  return "tool";
}
export function phaseLabel(phase = "pending") {
  const labels: Record<string, string> = {
    aborted: "Stopped",
    cancelled: "Stopped",
    cancelling: "Stopping",
    completed: "Completed",
    failed: "Failed",
    interrupted: "Stopped",
    pending: "Pending",
    retrying: "Retrying",
    running: "Running",
    starting: "Starting",
    stopped: "Stopped",
    waiting: "Waiting",
  };
  return labels[phase] ?? toolLabel(phase);
}
function activityOnly(blocks: Block[]) {
  return (
    blocks.length > 0 &&
    blocks.every(
      (block) =>
        block.kind === "thinking" ||
        block.kind === "toolCall" ||
        (block.kind === "text" && !block.text?.trim() && !block.artifactId),
    )
  );
}
export function copyableMessageText(blocks: Block[]) {
  return blocks
    .filter((block) => block.kind === "text" && block.text?.trim())
    .map((block) => block.text)
    .join("\n");
}
export type TranscriptEntry =
  | { kind: "message"; message: Message }
  | { kind: "activity"; messages: Message[] };

/** Merge persisted pages and the live tail without losing streaming revisions. */
export function mergeTranscriptMessages(
  pages: Message[],
  live: Message[],
): Message[] {
  const merged = new Map<string, Message>();
  for (const message of [...pages, ...live]) {
    const previous = merged.get(message.messageId);
    if (!previous || message.revision >= previous.revision)
      merged.set(message.messageId, message);
  }
  return [...merged.values()];
}

export function noticeIdentity(
  sessionId: string,
  notice: Data,
): string | undefined {
  const seq = Number(notice.eventSeq);
  if (!sessionId || !Number.isSafeInteger(seq) || seq <= 0) return undefined;
  const kind = typeof notice.code === "string" ? notice.code : "notice";
  return `${sessionId}:${seq}:${kind}`;
}

export function latestKnownUsage(current: Data, previous?: Data): Data {
  const entries = knownUsageEntries(current);
  return entries.length > 0 && entries.every((entry) => entry.value === 0)
    ? (previous ?? {})
    : current;
}

export function knownUsageEntries(usage: Data) {
  const entries: { key: string; label: string; value: number }[] = [];
  for (const [key, label] of [
    ["input", "Input tokens"],
    ["output", "Output tokens"],
    ["cacheRead", "Cache read"],
    ["cacheWrite", "Cache write"],
    ["cost", "Cost"],
  ] as const) {
    const value = usage[key];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0)
      entries.push({ key, label, value });
  }
  return entries;
}

export function transcriptEntries(messages: Message[]) {
  const entries: TranscriptEntry[] = [];
  for (const message of messages) {
    if (
      message.blocks.length === 0 ||
      message.blocks.every(
        (block) =>
          block.kind === "text" && !block.text?.trim() && !block.artifactId,
      )
    )
      continue;
    if (message.role === "assistant" && activityOnly(message.blocks)) {
      const last = entries.at(-1);
      if (last?.kind === "activity") last.messages.push(message);
      else entries.push({ kind: "activity", messages: [message] });
    } else {
      const previous = entries.at(-1);
      const firstContent = message.blocks.findIndex(
        (block) =>
          block.kind !== "thinking" &&
          block.kind !== "toolCall" &&
          !(block.kind === "text" && !block.text?.trim() && !block.artifactId),
      );
      if (
        message.role === "assistant" &&
        previous?.kind === "activity" &&
        firstContent > 0
      ) {
        previous.messages.push({
          ...message,
          blocks: message.blocks.slice(0, firstContent),
        });
        entries.push({
          kind: "message",
          message: { ...message, blocks: message.blocks.slice(firstContent) },
        });
      } else entries.push({ kind: "message", message });
    }
  }
  return entries;
}
export function activityBlocksLabel(blocks: Block[]) {
  const count = blocks.filter((block) => block.kind === "toolCall").length;
  return count ? `${count} tool ${count === 1 ? "call" : "calls"}` : "Thinking";
}
export function activityGroupLabel(messages: Message[]) {
  return activityBlocksLabel(messages.flatMap((message) => message.blocks));
}
export type BlockEntry =
  | { kind: "block"; block: Block }
  | { kind: "activity"; blocks: Block[] }
  | { kind: "images"; blocks: Block[] };
export function blockEntries(blocks: Block[]) {
  const entries: BlockEntry[] = [];
  for (const block of blocks) {
    if (block.kind === "text" && !block.text?.trim() && !block.artifactId)
      continue;
    if (block.kind === "thinking" || block.kind === "toolCall") {
      const last = entries.at(-1);
      if (last?.kind === "activity") last.blocks.push(block);
      else entries.push({ kind: "activity", blocks: [block] });
    } else if (block.kind === "image") {
      const last = entries.at(-1);
      if (last?.kind === "images") last.blocks.push(block);
      else entries.push({ kind: "images", blocks: [block] });
    } else entries.push({ kind: "block", block });
  }
  return entries;
}
