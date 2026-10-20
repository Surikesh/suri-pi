import { z } from "zod";
export const VERSION = 1;
export const runtimeVersions = ["0.84.4", "0.85.1"] as const;
export const activePhases = new Set([
  "starting",
  "running",
  "waiting",
  "compacting",
  "retrying",
  "cancelling",
]);
export const CommandSchema = z.object({
  v: z.literal(1),
  id: z.uuid(),
  createdAt: z.iso.datetime(),
  type: z.string().max(64),
  sessionId: z.uuid().optional(),
  expectedRevision: z.number().int().nonnegative().optional(),
  payload: z.record(z.string(), z.unknown()),
});
export type Command = z.infer<typeof CommandSchema>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- legacy dynamic wire payload compatibility: Data is the open JSON bag read by hundreds of host/web/test sites; unknown here forces coercions and edits to frozen tests
export type Data = Record<string, any>;
export type Receipt = {
  v: 1;
  id: string;
  status: "accepted" | "completed" | "rejected" | "indeterminate";
  result?: Data;
  error?: { code: string; message: string; retryable: boolean };
};
export type Block = {
  kind:
    | "text"
    | "thinking"
    | "code"
    | "image"
    | "toolCall"
    | "toolResult"
    | "custom"
    | "unknown";
  id: string;
  text?: string;
  callId?: string;
  name?: string;
  arguments?: Data;
  artifactId?: string;
  mime?: string;
  isError?: boolean;
  blocks?: Block[];
};
export type Message = {
  messageId: string;
  role: string;
  blocks: Block[];
  revision: number;
  final: boolean;
  entryId?: string;
};
export type Event = {
  v: 1;
  hostEpoch: string;
  streamId: string;
  seq: number;
  type: string;
  at: string;
  sessionId?: string;
  runId?: string;
  causationId?: string;
  payload: Data;
};
export type Projection = {
  phase: string;
  outcome?: string;
  messages: Message[];
  tools: Record<string, Data>;
  queue: Data[];
  interactions: Record<string, Data>;
  extensions?: Record<string, Data>;
  usage: Data;
  notices: Data[];
  seq: number;
};
export const initialProjection = (): Projection => ({
  phase: "idle",
  messages: [],
  tools: {},
  queue: [],
  interactions: {},
  usage: {},
  notices: [],
  seq: 0,
});
export function reduce(
  state: Projection,
  event: Pick<Event, "type" | "payload" | "seq">,
): Projection {
  if (event.seq <= state.seq) return state;
  const p = event.payload;
  let next = { ...state, seq: event.seq };
  switch (event.type) {
    case "run.state":
    case "session.state":
      next = { ...next, phase: p.phase, outcome: p.outcome };
      break;
    case "message.upsert": {
      const msg = p as Message;
      const i = state.messages.findIndex((m) => m.messageId === msg.messageId);
      const messages = state.messages.slice();
      if (i < 0) messages.push(msg);
      else if (messages[i].revision < msg.revision) messages[i] = msg;
      next.messages = messages.slice(-10000);
      break;
    }
    case "message.delta":
      next.messages = state.messages.map((m) =>
        m.messageId !== p.messageId || m.revision >= p.revision
          ? m
          : {
              ...m,
              revision: p.revision,
              blocks: m.blocks.map((b) =>
                b.id === p.blockId
                  ? { ...b, text: ((b.text ?? "") + p.text).slice(0, 65536) }
                  : b,
              ),
            },
      );
      break;
    case "tool.state":
      next.tools = {
        ...state.tools,
        [p.callId]: { ...state.tools[p.callId], ...p },
      };
      if (Object.keys(next.tools).length > 1000) {
        const old = Object.keys(next.tools).find(
          (id) => !["running", "starting"].includes(next.tools[id].phase),
        );
        if (old) delete next.tools[old];
      }
      break;
    case "queue.state":
      next.queue = p.items;
      break;
    case "interaction.request":
      next.interactions = { ...state.interactions, [p.interactionId]: p };
      break;
    case "interaction.closed":
      next.interactions = { ...state.interactions };
      delete next.interactions[p.interactionId];
      break;
    case "extension.widget":
    case "extension.status":
    case "extension.editor":
      next.extensions = {
        ...state.extensions,
        [`${event.type}:${p.key}`]: { ...p, type: event.type, seq: event.seq },
      };
      if (Object.keys(next.extensions).length > 100)
        delete next.extensions[Object.keys(next.extensions)[0]];
      break;
    case "usage.updated":
      next.usage = p;
      break;
    case "notice":
      next.notices = [
        ...state.notices.filter((notice) => !p.code || notice.code !== p.code),
        { ...p, eventSeq: event.seq },
      ].slice(-30);
      break;
    case "adapter.unknown":
      next.notices = [...state.notices, { ...p, eventSeq: event.seq }].slice(
        -30,
      );
      break;
  }
  return next;
}
export class SuriError extends Error {
  constructor(
    public code: string,
    message: string,
    public retryable = false,
  ) {
    super(message);
  }
}
export function failure(id: string, error: unknown): Receipt {
  const e =
    error instanceof SuriError
      ? error
      : new SuriError("INTERNAL", "The operation could not be completed.");
  return {
    v: 1,
    id,
    status: e.code === "INDETERMINATE" ? "indeterminate" : "rejected",
    error: { code: e.code, message: e.message, retryable: e.retryable },
  };
}
export function requiredString(p: Data, key: string, max = 1024): string {
  const v = p[key];
  if (typeof v !== "string" || !v.length || v.length > max)
    throw new SuriError("VALIDATION", `Invalid ${key}.`);
  return v;
}
export function publicModel(m: Data): Data {
  return {
    id: String(m.id ?? ""),
    provider: String(m.provider ?? ""),
    name: String(m.name ?? m.id ?? ""),
    reasoning: !!m.reasoning,
    contextWindow: Number(m.contextWindow) || undefined,
    input: Array.isArray(m.input)
      ? m.input.filter((x: unknown) => x === "text" || x === "image")
      : [],
  };
}
