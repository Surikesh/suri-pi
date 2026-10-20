import {
  activePhases,
  SuriError,
  requiredString,
  type Command,
  type Data,
} from "../../../packages/protocol/src/index.js";
import { queueablePhases } from "./host-contract.js";
import type { HostQueue } from "./host-queue.js";
import type { HostRuntime } from "./host-runtime.js";
import type { Interactions } from "./host-interactions.js";
import type { MessageWrites } from "./host-message-writes.js";
import type { Stream } from "./host-stream.js";
import { sessionTitle } from "./session-name.js";
import type { Storage } from "./storage.js";

type SubmitPrelude = {
  text: string;
  running: boolean;
  queueable: boolean;
  attachmentIds: string[];
  /** Immediate-extension probe wanted: running prompt flagged by the client. */
  probesExtension: boolean;
};

/**
 * Synchronous run, queue and interaction command bodies. Awaited cases keep
 * their await frame and async job callbacks in the dispatcher.
 */
export function createRunCommands(caps: {
  store: Storage;
  hostRuntime: Pick<HostRuntime, "client" | "hasSubmission">;
  hostQueue: Pick<HostQueue, "shadows" | "setShadows">;
  interactions: Pick<Interactions, "get" | "delete">;
  publish: Stream["publish"];
  emit: MessageWrites["emit"];
}) {
  const { store, hostRuntime, hostQueue, interactions, publish, emit } = caps;
  return {
    /** Validation before the optional awaited immediate-extension probe. */
    runSubmitPrelude(p: Data, id: string): SubmitPrelude {
      const text = requiredString(p, "text", 1048576);
      if (!["prompt", "steer", "followUp"].includes(p.mode))
        throw new SuriError("VALIDATION", "Choose a delivery mode.");
      const phase = store.snapshot(`session:${id}`).phase;
      const running = activePhases.has(phase) || hostRuntime.hasSubmission(id);
      const queueable =
        queueablePhases.has(phase) || hostRuntime.hasSubmission(id);
      return {
        text,
        running,
        queueable,
        attachmentIds: p.attachmentIds ?? [],
        probesExtension:
          p.mode === "prompt" && running && p.immediateExtension === true,
      };
    },
    extensionName(text: string) {
      return text.match(/^\/([^\s]+)/)?.[1];
    },
    isExtension(available: Data, candidate: string | undefined) {
      return (available.commands ?? []).some(
        (entry: Data) =>
          entry.name === candidate && entry.source === "extension",
      );
    },
    /** Admission checks and session touch, between the probe and `assets.prompt`. */
    runSubmitTouch(
      prelude: SubmitPrelude,
      p: Data,
      id: string,
      immediateExtension: boolean,
    ) {
      const { text, running, queueable } = prelude;
      if (p.mode === "prompt" && running && !immediateExtension)
        throw new SuriError("BUSY", "Choose Steer or Follow-up while running.");
      if (p.mode !== "prompt" && !queueable)
        throw new SuriError(
          "VALIDATION",
          running
            ? "Queue delivery is unavailable while Pi is compacting or stopping."
            : "Queue delivery requires an active run.",
        );
      const currentSession = store.get("session", id);
      const touched = store.patch(
        "session",
        id,
        currentSession.revision,
        p.mode === "prompt" &&
          currentSession.name === "New session" &&
          currentSession.nameSource !== "manual"
          ? {
              name: sessionTitle(text),
              nameSource: "automatic",
              hasConversation: true,
            }
          : { hasConversation: true },
      );
      publish("catalog", "catalog.session", touched);
    },
    /** Shadow-queue bookkeeping after `assets.prompt` resolved. */
    runSubmitShadow(
      c: Command,
      p: Data,
      id: string,
      text: string,
      message: Data,
      clientId: string,
    ) {
      if (p.mode !== "prompt") {
        if (store.snapshot(`session:${id}`).queue.length >= 32)
          throw new SuriError("LIMIT_EXCEEDED", "The pending queue is full.");
        hostQueue.setShadows(id, [
          ...(hostQueue.shadows(id) ?? []).slice(-63),
          {
            queueId: c.id,
            mode: p.mode,
            text,
            wireText: message.message,
            attachmentIds: p.attachmentIds ?? [],
            clientId,
          },
        ]);
      }
    },
    runForceStop(id: string | undefined): Data {
      const result: Data = {};
      if (!id) throw new SuriError("VALIDATION", "Select a session.");
      if (store.snapshot(`session:${id}`).phase !== "cancelling")
        throw new SuriError("VALIDATION", "Request Stop first.");
      hostRuntime.client(id)?.forceStop();
      return result;
    },
    /** Synchronous validation of queue.update, before the job is submitted. */
    queueUpdatePrelude(
      p: Data,
      id: string,
    ): { mode: string; text: string; queue: Data[]; target: number } {
      const queueId = requiredString(p, "queueId", 200);
      const mode = requiredString(p, "mode", 20);
      const text = requiredString(p, "text", 1048576);
      if (!["steer", "followUp"].includes(mode))
        throw new SuriError("VALIDATION", "Choose Steer or Follow-up.");
      const queue = store.snapshot(`session:${id}`).queue;
      const target = queue.findIndex((item: Data) => item.queueId === queueId);
      if (target < 0)
        throw new SuriError(
          "NOT_FOUND",
          "This queued message is no longer available to edit.",
        );
      return { mode, text, queue, target };
    },
    interactionRespond(p: Data, id: string | undefined): Data {
      const result: Data = {};
      const item = interactions.get(p.interactionId);
      if (!item || item.sessionId !== id)
        throw new SuriError(
          "STALE_INTERACTION",
          "This question is no longer pending.",
        );
      const a = p.answer ?? {};
      if (!a.cancelled) {
        if (item.raw.method === "confirm" && typeof a.confirmed !== "boolean")
          throw new SuriError("VALIDATION", "Confirmation required.");
        if (item.raw.method !== "confirm" && typeof a.value !== "string")
          throw new SuriError("VALIDATION", "Text response required.");
        if (item.raw.method === "select" && !item.raw.options.includes(a.value))
          throw new SuriError("VALIDATION", "Choose an available option.");
      }
      hostRuntime.client(id!)?.respond(item.raw.id, a);
      clearTimeout(item.timer);
      interactions.delete(p.interactionId);
      emit(id!, "interaction.closed", {
        interactionId: p.interactionId,
        reason: "resolved",
      });
      return result;
    },
  };
}
