import type {
  Block,
  Data,
  Message,
} from "../../../packages/protocol/src/index.js";

export type ChangedFile = {
  path: string;
  code: string;
  staged: boolean;
  unstaged: boolean;
  untracked: boolean;
  renamedFrom?: string;
};

function relativeWorkspacePath(value: unknown, workspaceRoot?: string) {
  if (typeof value !== "string") return undefined;
  let path = value.trim().replace(/\\/g, "/");
  const line = path.match(/(?::\d+(?::\d+)?|#L\d+)$/);
  if (line) path = path.slice(0, line.index);
  if (workspaceRoot?.startsWith("/private/var/") && path.startsWith("/var/"))
    path = `/private${path}`;
  if (workspaceRoot && path.startsWith(`${workspaceRoot}/`))
    path = path.slice(workspaceRoot.length + 1);
  else if (path.startsWith("/")) return undefined;
  path = path.replace(/^\.\//, "");
  if (!path || path === "." || path.includes("\0")) return undefined;
  const segments = path.split("/");
  if (segments.some((segment) => !segment || segment === ".."))
    return undefined;
  return path;
}

function changedPath(block: Block, tools: Record<string, Data>, root?: string) {
  if (block.kind !== "toolCall") return undefined;
  const tool = block.callId ? tools[block.callId] : undefined;
  if (tool?.phase !== "completed" || tool?.isError) return undefined;
  const name = String(tool?.name ?? block.name ?? "").toLowerCase();
  if (!/^(write|edit|patch|apply_patch)$/.test(name)) return undefined;
  const args = { ...(block.arguments ?? {}), ...(tool?.arguments ?? {}) };
  return relativeWorkspacePath(args.path ?? args.filePath ?? args.file, root);
}

/** Associates edit/write tool calls with the next visible assistant response. */
export function changedFilesByMessage(
  messages: Message[],
  tools: Record<string, Data>,
  workspaceRoot?: string,
) {
  const result = new Map<string, string[]>();
  const pending: string[] = [];
  for (const message of messages) {
    if (message.role === "user") pending.length = 0;
    if (message.role !== "assistant") continue;
    for (const block of message.blocks) {
      const path = changedPath(block, tools, workspaceRoot);
      if (path && !pending.includes(path)) pending.push(path);
    }
    const hasVisibleResponse = message.blocks.some(
      (block) => block.kind === "text" && Boolean(block.text?.trim()),
    );
    if (hasVisibleResponse && pending.length) {
      result.set(message.messageId, [...pending]);
      pending.length = 0;
    }
  }
  return result;
}

export function parseGitStatus(text: string): ChangedFile[] {
  const files: ChangedFile[] = [];
  const records = text.split("\0").filter(Boolean);
  for (let index = 0; index < records.length; index++) {
    const record = records[index];
    if (record.startsWith("? ")) {
      files.push({
        path: record.slice(2),
        code: "U",
        staged: false,
        unstaged: true,
        untracked: true,
      });
      continue;
    }
    if (record.startsWith("! ")) continue;
    const kind = record[0];
    if (kind !== "1" && kind !== "2") continue;
    const fields = record.split(" ");
    const xy = fields[1] ?? "..";
    const path = fields.slice(kind === "2" ? 9 : 8).join(" ");
    const renamedFrom = kind === "2" ? records[++index] : undefined;
    if (!path) continue;
    const stagedCode = xy[0] === "." ? "" : xy[0];
    const unstagedCode = xy[1] === "." ? "" : xy[1];
    files.push({
      path,
      code: unstagedCode || stagedCode || "M",
      staged: Boolean(stagedCode),
      unstaged: Boolean(unstagedCode),
      untracked: false,
      ...(renamedFrom ? { renamedFrom } : {}),
    });
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

export function diffStats(text: string) {
  let additions = 0;
  let deletions = 0;
  for (const line of parseDiff(text)) {
    if (line.kind === "add") additions++;
    else if (line.kind === "remove") deletions++;
  }
  return { additions, deletions };
}

export function untrackedDiff(path: string, content: string) {
  const lines = content.split("\n");
  const count = lines.length - Number(lines.at(-1) === "");
  return [
    `diff --git a/${path} b/${path}`,
    "new file mode 100644",
    "--- /dev/null",
    `+++ b/${path}`,
    `@@ -0,0 +1,${count} @@`,
    ...lines.slice(0, count).map((line) => `+${line}`),
    ...(content && !content.endsWith("\n")
      ? ["\\ No newline at end of file"]
      : []),
  ].join("\n");
}

type DiffRow = {
  kind: "add" | "remove" | "context" | "hunk" | "note";
  text: string;
  old?: number;
  new?: number;
};
/** Parse only hunk bodies. Headers never become source, even for +++ content. */
export function parseDiff(text: string): DiffRow[] {
  const rows: DiffRow[] = [];
  let old = 0,
    next = 0,
    active = false;
  for (const line of text.split("\n")) {
    const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/.exec(line);
    if (hunk) {
      old = Number(hunk[1]);
      next = Number(hunk[3]);
      active = true;
      rows.push({
        kind: "hunk",
        text: `Lines ${hunk[1]} → ${hunk[3]}${hunk[5]}`,
      });
    } else if (line.startsWith("diff --git")) active = false;
    else if (active && line.startsWith("+"))
      rows.push({ kind: "add", text: line.slice(1), new: next++ });
    else if (active && line.startsWith("-"))
      rows.push({ kind: "remove", text: line.slice(1), old: old++ });
    else if (active && line.startsWith(" "))
      rows.push({
        kind: "context",
        text: line.slice(1),
        old: old++,
        new: next++,
      });
    else if (active && line.startsWith("\\"))
      rows.push({ kind: "note", text: line.slice(2) });
  }
  return rows;
}
