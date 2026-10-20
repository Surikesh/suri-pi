import type { IncomingMessage, ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { SuriError } from "../../../packages/protocol/src/index.js";

export const token = () => randomBytes(32).toString("hex");
export const queueablePhases = new Set([
  "starting",
  "running",
  "waiting",
  "retrying",
]);
export const builtinSlashCommands = [
  ["settings", "Open Suri settings", true],
  ["model", "Select model", true],
  ["tree", "Navigate the session tree", true],
  ["thinking", "Set thinking level", true],
  ["scoped-models", "Choose models shown in Suri's model picker", true],
  ["export", "Export the session", true],
  ["import", "Review and import a Pi history", true],
  ["share", "Share the session as a private gist", false],
  ["copy", "Copy the last Pi message", true],
  ["name", "Set the session display name", true],
  ["session", "Show session information and stats", true],
  ["changelog", "Show the pinned Pi version", true],
  ["hotkeys", "Show keyboard shortcuts", true],
  ["fork", "Fork from a previous user message", true],
  ["clone", "Duplicate the current session", true],
  ["trust", "Save the project trust decision", false],
  ["login", "Configure provider authentication", false],
  ["logout", "Remove provider authentication", false],
  ["new", "Start a new session", true],
  ["compact", "Manually compact the session context", true],
  ["resume", "Resume this session", true],
  ["reload", "Reload Pi resources", true],
  ["quit", "Quit Suri Pi", true],
] as const;

export function json(res: ServerResponse, status: number, value: unknown) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(value));
}

export async function body(
  req: IncomingMessage,
  max = 1048576,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > max)
      throw new SuriError("LIMIT_EXCEEDED", "Request is too large.");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export const hostIdentity = {
  product: "suri-pi",
  productVersion: "0.1.0",
  protocol: 1,
  uiContract: 1,
  storageSchema: 1,
  capabilities: ["local-browser", "authenticated-bootstrap"],
} as const;
