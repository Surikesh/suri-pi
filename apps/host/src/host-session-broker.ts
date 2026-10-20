import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import type { ReviewQueueHost } from "../../../packages/pi-adapter/src/review-queue.js";
import { REVIEW_QUEUE_CONTROL_PROTOCOL } from "../../../packages/pi-adapter/src/review-queue.js";
import {
  createBrokerHandshake,
  destroyBrokerKey,
  signBrokerFrame,
  verifyBrokerFrame,
} from "../../../packages/model-chain/src/broker.js";
import {
  type Command,
  type Data,
} from "../../../packages/protocol/src/index.js";
import type { ExecuteUnlocked } from "./host-queue-workers.js";
import type { HostRuntime } from "./host-runtime.js";
import type { Storage } from "./storage.js";

/** Host-lifetime owner of broker authority: chain bindings across all children. */
export function createSessionBroker(caps: {
  store: Storage;
  options: { validation?: boolean };
  instanceId: string;
  reviewQueueHost: ReviewQueueHost;
  executeUnlocked: ExecuteUnlocked;
  markQueueSessionState: (id: string, state: string) => void;
  hostRuntime: Pick<HostRuntime, "client">;
}) {
  const {
    store,
    options,
    instanceId,
    reviewQueueHost,
    executeUnlocked,
    markQueueSessionState,
    hostRuntime,
  } = caps;
  const chainBindings = new Map<
    string,
    {
      channelId: string;
      sourceSessionId: string;
      requestId: string;
      stageId: string;
      attemptId: string;
      workspaceId: string;
      runtimeId: string;
      targetSessionId: string;
      provider: "openai-codex";
      modelId: string;
      thinking: string;
      promptHash: string;
      expiresAt: number;
      sequence: string[];
      next: number;
      submitted: boolean;
      phase: "registered" | "created" | "model" | "thinking" | "submitted";
    }
  >();
  function open(id: string, workspace: Data, runtime: Data) {
    const queueWorkerBinding = reviewQueueHost.binding(id);
    const broker = createBrokerHandshake(instanceId);
    let brokerRequestCounter = 0;
    let brokerResponseCounter = 0;
    const brokerHostReads = new Set<string>();
    const revokeBroker = () => {
      destroyBrokerKey(broker.key);
      for (const binding of reviewQueueHost.sourceExited(
        id,
        broker.handshake.channelId,
      )) {
        markQueueSessionState(binding.hostSessionId, "revoked");
        hostRuntime.client(binding.hostSessionId)?.forceStop();
      }
      for (const [key, binding] of chainBindings)
        if (binding.channelId === broker.handshake.channelId)
          chainBindings.delete(key);
    };
    const privateControl = options.validation
      ? undefined
      : {
          handshake: JSON.stringify(broker.handshake),
          close: revokeBroker,
          handle: async (rawFrame: string) => {
            let packet: Data;
            try {
              packet = verifyBrokerFrame(
                broker.key,
                broker.handshake.channelId,
                brokerRequestCounter + 1,
                rawFrame,
              ) as Data;
              brokerRequestCounter += 1;
            } catch {
              return undefined;
            }
            const respond = (payload: Data) =>
              JSON.stringify(
                signBrokerFrame(
                  broker.key,
                  broker.handshake.channelId,
                  ++brokerResponseCounter,
                  payload,
                ),
              );
            try {
              if (queueWorkerBinding) {
                if (packet?.protocol !== "suri-review-queue-worker-v1")
                  throw new Error("SURI_QUEUE_WORKER_CAPABILITY_INVALID");
                return respond(
                  (await reviewQueueHost.handleWorker(id, packet)) as Data,
                );
              }
              if (packet?.protocol === REVIEW_QUEUE_CONTROL_PROTOCOL) {
                return respond(
                  (await reviewQueueHost.handleControl(
                    {
                      sourceHostSessionId: id,
                      sourceChannelId: broker.handshake.channelId,
                      workspaceId: workspace.id,
                      repository: await realpath(workspace.root),
                      runtimeId: runtime.id,
                    },
                    packet,
                  )) as Data,
                );
              }
              if (
                packet?.protocol !== "suri-model-chain-v1" ||
                typeof packet.requestId !== "string" ||
                typeof packet.stageId !== "string" ||
                !/^[a-z][a-z0-9-]{0,63}$/.test(packet.stageId) ||
                typeof packet.type !== "string" ||
                typeof packet.commandId !== "string" ||
                packet.workspace !== workspace.root
              )
                throw new Error("SURI_CHAIN_CAPABILITY_INVALID");
              const source = store.get("session", id);
              if (source.runtimeId !== runtime.id)
                throw new Error("SURI_CHAIN_CAPABILITY_INVALID");
              const stageKey = `${packet.requestId}:${packet.stageId}`;
              if (packet.type === "host.get") {
                if (brokerHostReads.has(stageKey))
                  throw new Error("SURI_CHAIN_SEQUENCE_INVALID");
                brokerHostReads.add(stageKey);
                const receipt = await executeUnlocked(
                  {
                    v: 1,
                    id: packet.commandId,
                    createdAt: new Date().toISOString(),
                    type: "host.get",
                    payload: {},
                  },
                  `chain:${id}`,
                );
                return respond({
                  ok: true,
                  receipt,
                  chainContext: { runtimeId: source.runtimeId },
                });
              }
              if (!brokerHostReads.has(stageKey))
                throw new Error("SURI_CHAIN_SEQUENCE_INVALID");
              const bindingId = `${broker.handshake.channelId}:${packet.requestId}:${packet.stageId}`;
              if (packet.type === "stage.register") {
                if (chainBindings.has(bindingId))
                  throw new Error("SURI_CHAIN_SEQUENCE_INVALID");
                const p = packet.payload ?? {};
                const sequence = p.commandSequence;
                if (
                  packet.runtimeId !== source.runtimeId ||
                  p.provider !== "openai-codex" ||
                  typeof p.modelId !== "string" ||
                  !p.modelId ||
                  typeof p.thinking !== "string" ||
                  ![
                    "off",
                    "minimal",
                    "low",
                    "medium",
                    "high",
                    "xhigh",
                    "max",
                  ].includes(p.thinking) ||
                  typeof p.attemptId !== "string" ||
                  !/^[0-9a-f-]{36}$/i.test(p.attemptId) ||
                  typeof p.targetSessionId !== "string" ||
                  !/^[0-9a-f-]{36}$/i.test(p.targetSessionId) ||
                  typeof p.promptHash !== "string" ||
                  !/^[a-f0-9]{64}$/.test(p.promptHash) ||
                  !Number.isFinite(p.expiresAt) ||
                  p.expiresAt <= Date.now() ||
                  p.expiresAt > Date.now() + 5 * 60_000 ||
                  JSON.stringify(sequence) !==
                    JSON.stringify([
                      "session.create",
                      "model.set",
                      "thinking.set",
                      "run.submit",
                    ])
                )
                  throw new Error("SURI_CHAIN_AUTHORIZATION_INVALID");
                const registrationId = createHash("sha256")
                  .update(
                    JSON.stringify([
                      instanceId,
                      broker.handshake.channelId,
                      packet.requestId,
                      packet.stageId,
                      p.attemptId,
                      p.targetSessionId,
                      source.workspaceId,
                      source.runtimeId,
                      p.provider,
                      p.modelId,
                      p.thinking,
                      p.promptHash,
                      p.expiresAt,
                      sequence,
                    ]),
                  )
                  .digest("hex");
                chainBindings.set(bindingId, {
                  channelId: broker.handshake.channelId,
                  sourceSessionId: id,
                  requestId: packet.requestId,
                  stageId: packet.stageId,
                  attemptId: p.attemptId,
                  workspaceId: source.workspaceId,
                  runtimeId: source.runtimeId,
                  targetSessionId: p.targetSessionId,
                  provider: "openai-codex",
                  modelId: p.modelId,
                  thinking: p.thinking,
                  promptHash: p.promptHash,
                  expiresAt: p.expiresAt,
                  sequence: [...sequence],
                  next: 0,
                  submitted: false,
                  phase: "registered",
                });
                return respond({ ok: true, registrationId });
              }
              const binding = chainBindings.get(bindingId);
              if (
                !binding ||
                binding.sourceSessionId !== id ||
                binding.runtimeId !== source.runtimeId ||
                binding.workspaceId !== source.workspaceId ||
                binding.expiresAt <= Date.now() ||
                packet.registrationId !==
                  createHash("sha256")
                    .update(
                      JSON.stringify([
                        instanceId,
                        broker.handshake.channelId,
                        binding.requestId,
                        binding.stageId,
                        binding.attemptId,
                        binding.targetSessionId,
                        binding.workspaceId,
                        binding.runtimeId,
                        binding.provider,
                        binding.modelId,
                        binding.thinking,
                        binding.promptHash,
                        binding.expiresAt,
                        binding.sequence,
                      ]),
                    )
                    .digest("hex") ||
                binding.sequence[binding.next] !== packet.type ||
                packet.runtimeId !== binding.runtimeId
              )
                throw new Error("SURI_CHAIN_AUTHORIZATION_INVALID");
              const p = packet.payload ?? {};
              if (
                (packet.type !== "session.create" &&
                  packet.sessionId !== binding.targetSessionId) ||
                (packet.type === "model.set" &&
                  (binding.phase !== "created" ||
                    p.provider !== binding.provider ||
                    p.id !== binding.modelId)) ||
                (packet.type === "thinking.set" &&
                  (binding.phase !== "model" ||
                    p.level !== binding.thinking)) ||
                (packet.type === "run.submit" &&
                  (binding.phase !== "thinking" ||
                    binding.submitted ||
                    p.mode !== "prompt" ||
                    !Array.isArray(p.attachmentIds) ||
                    p.attachmentIds.length !== 0 ||
                    typeof p.text !== "string" ||
                    p.text.length > 25_000 ||
                    createHash("sha256").update(p.text).digest("hex") !==
                      binding.promptHash))
              )
                throw new Error("SURI_CHAIN_AUTHORIZATION_INVALID");
              const command: Command = {
                v: 1,
                id: packet.commandId,
                createdAt: new Date().toISOString(),
                type: packet.type,
                ...(packet.type === "session.create"
                  ? {}
                  : { sessionId: binding.targetSessionId }),
                ...(Number.isInteger(packet.expectedRevision)
                  ? { expectedRevision: packet.expectedRevision }
                  : {}),
                payload:
                  packet.type === "session.create"
                    ? {
                        workspaceId: binding.workspaceId,
                        runtimeId: binding.runtimeId,
                        name: p.name,
                      }
                    : p,
              };
              const receipt = await executeUnlocked(
                command,
                `chain:${id}`,
                packet.type === "session.create"
                  ? { reservedSessionId: binding.targetSessionId }
                  : undefined,
              );
              if (receipt.status === "completed") {
                if (packet.type === "session.create") binding.phase = "created";
                if (packet.type === "model.set") binding.phase = "model";
                if (packet.type === "thinking.set") binding.phase = "thinking";
              }
              if (
                packet.type === "run.submit" &&
                (receipt.status === "accepted" ||
                  receipt.status === "completed")
              ) {
                binding.phase = "submitted";
                binding.submitted = true;
                chainBindings.delete(bindingId);
              }
              if (
                receipt.status === "completed" ||
                receipt.status === "accepted"
              )
                binding.next += 1;
              return respond({ ok: true, receipt });
            } catch (error) {
              const code =
                error instanceof Error &&
                /^[A-Z][A-Z0-9_]+$/.test(error.message)
                  ? error.message
                  : "SURI_CHAIN_CAPABILITY_INVALID";
              return respond({ ok: false, code });
            }
          },
        };
    return { queueWorkerBinding, privateControl };
  }
  return { open };
}
export type SessionBroker = ReturnType<typeof createSessionBroker>;
