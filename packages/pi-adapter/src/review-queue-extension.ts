import {
  consumeFdBrokerHandshake,
  takeStartupBrokerTransport,
} from "../../model-chain/src/adapters.js";

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, never>;
};
type WorkerReply = {
  ok?: unknown;
  category?: unknown;
  role: string;
  result?: unknown;
};
type ExtensionApi = {
  registerTool(definition: {
    name: string;
    label: string;
    description: string;
    parameters: Record<string, unknown>;
    execute: (
      id: string,
      input: Record<string, unknown>,
    ) => Promise<ToolResult>;
  }): void;
};
const string = (maxLength: number) => ({
  type: "string",
  minLength: 1,
  maxLength,
});
const object = (properties: Record<string, unknown>, required: string[]) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});
const response = (value: unknown): ToolResult => ({
  content: [{ type: "text", text: JSON.stringify(value) }],
  details: {},
});

/** Exact explicit extension loaded by the host-owned queue worker profile. */
export default async function reviewQueueExtension(pi: ExtensionApi) {
  await consumeFdBrokerHandshake();
  const send = takeStartupBrokerTransport();
  const request = async (
    operation: string,
    payload: Record<string, unknown>,
  ) => {
    const value = (await send({
      protocol: "suri-review-queue-worker-v1",
      operation,
      ...payload,
    })) as WorkerReply | undefined;
    if (!value?.ok)
      throw new Error(String(value?.category ?? "QUEUE_WORKER_DENIED"));
    return value;
  };
  const binding = await request("bind", {});
  if (!["implementer", "reviewer"].includes(binding.role))
    throw new Error("QUEUE_WORKER_BINDING_INVALID");
  const call = async (operation: string, payload: Record<string, unknown>) =>
    response((await request(operation, payload)).result ?? { ok: true });
  pi.registerTool({
    name: "queue_read",
    label: "Queue Read",
    description: "Read one bounded UTF-8 file below the bound workspace.",
    parameters: object({ path: string(4096) }, ["path"]),
    execute: async (_id, input) => call("read", { target: input.path }),
  });
  pi.registerTool({
    name: "queue_write",
    label: "Queue Write",
    description:
      "Write one bounded UTF-8 file through the current writer fence.",
    parameters: object(
      {
        path: string(4096),
        content: { type: "string", maxLength: 1024 * 1024 },
      },
      ["path", "content"],
    ),
    execute: async (_id, input) =>
      call("write", { target: input.path, bytes: input.content }),
  });
  pi.registerTool({
    name: "queue_exec",
    label: "Queue Exec",
    description:
      "Execute one direct binary with argv inside the host-enforced workspace sandbox. Shells, interpreters, command builders, and process descendants are denied.",
    parameters: object(
      {
        executable: string(4096),
        args: {
          type: "array",
          items: { type: "string", maxLength: 8192 },
          maxItems: 128,
        },
      },
      ["executable", "args"],
    ),
    execute: async (_id, input) => call("exec", input),
  });
  pi.registerTool({
    name: "queue_result",
    label: "Queue Result",
    description:
      "Write a bounded reviewer verdict into host-owned scratch storage.",
    parameters: object(
      {
        path: string(4096),
        content: { type: "string", maxLength: 1024 * 1024 },
      },
      ["path", "content"],
    ),
    execute: async (_id, input) =>
      call("result", { target: input.path, bytes: input.content }),
  });
}
