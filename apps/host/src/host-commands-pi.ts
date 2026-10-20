import {
  SuriError,
  requiredString,
  type Command,
  type Data,
} from "../../../packages/protocol/src/index.js";
import { CodexUsageReader } from "./codex-usage.js";
import { builtinSlashCommands } from "./host-contract.js";
import type { HostRuntime } from "./host-runtime.js";
import type { Stream } from "./host-stream.js";
import type { Storage } from "./storage.js";

/**
 * Synchronous Pi runtime, usage and context command parts. Owns the Codex
 * usage readers privately. Awaited Pi requests stay in the dispatcher.
 */
export function createPiCommands(caps: {
  store: Storage;
  hostRuntime: Pick<HostRuntime, "client">;
  publish: Stream["publish"];
  idle: (sessionId: string) => void;
  closing: () => boolean;
}) {
  const { store, hostRuntime, publish, idle } = caps;
  const codexUsageReaders = new Map<string, CodexUsageReader>();
  return {
    /** Returns the pending usage read, or undefined when no runtime exists. */
    usageCodex(): Promise<Data> | undefined {
      const sessions = store.list("session");
      const codexSession = sessions.find(
        (candidate) => candidate.model?.provider === "openai-codex",
      );
      const runtimeId =
        codexSession?.runtimeId ??
        sessions[0]?.runtimeId ??
        store.list("runtime")[0]?.id;
      if (!runtimeId) {
        return undefined;
      }
      const runtime = store.get("runtime", runtimeId);
      let reader = codexUsageReaders.get(runtime.id);
      if (!reader) {
        reader = new CodexUsageReader(runtime.executable);
        codexUsageReaders.set(runtime.id, reader);
      }
      return reader.read();
    },
    /** Synchronous prelude of session.context, before the optional stats request. */
    contextPrelude(id: string) {
      const session = store.get("session", id);
      const snapshot = store.snapshot(`session:${id}`);
      const cachedContext = snapshot.usage.contextUsage ?? null;
      const pi = hostRuntime.client(id);
      return { session, snapshot, cachedContext, pi };
    },
    /** Publishes changed context usage after the optional stats request. */
    contextUsage(
      id: string,
      prelude: { snapshot: Data; cachedContext: unknown },
      stats: Data,
    ) {
      const { cachedContext } = prelude;
      let { snapshot } = prelude;
      const contextUsage = stats.contextUsage ?? cachedContext;
      if (
        contextUsage &&
        JSON.stringify(contextUsage) !== JSON.stringify(cachedContext)
      ) {
        publish(`session:${id}`, "usage.updated", {
          ...snapshot.usage,
          contextUsage,
        });
        snapshot = store.snapshot(`session:${id}`);
      }
      return { contextUsage, snapshot };
    },
    /** Races a pending Codex read against the 500 ms loading fallback (non-async). */
    contextRace(read: Promise<Data>) {
      return Promise.race([
        read,
        new Promise<Data>((resolve) =>
          setTimeout(
            () => resolve({ available: false, reason: "loading" }),
            500,
          ),
        ),
      ]);
    },
    contextResult(contextUsage: unknown, pi: unknown, codexUsage?: Data) {
      return {
        contextUsage,
        available: !!contextUsage || !!pi,
        ...(codexUsage ? { codexUsage } : {}),
      };
    },
    /** Starts the Codex usage read for a Codex session; the race stays in the dispatcher. */
    contextCodexRead(id: string, session: Data): Promise<Data> | undefined {
      if (session.model?.provider === "openai-codex") {
        const runtime = store.get("runtime", session.runtimeId);
        let reader = codexUsageReaders.get(runtime.id);
        if (!reader) {
          reader = new CodexUsageReader(runtime.executable);
          codexUsageReaders.set(runtime.id, reader);
        }
        const read = reader.read();
        void read.then((usage) => {
          if (!caps.closing() && usage.available === true) {
            const current = store.snapshot(`session:${id}`);
            if (
              JSON.stringify(current.usage.codexUsage) !== JSON.stringify(usage)
            )
              publish(`session:${id}`, "usage.updated", {
                ...current.usage,
                codexUsage: usage,
              });
          }
        });
        return read;
      }
      return undefined;
    },
    /** Synchronous prelude of the model/thinking/commands/compact/tree/info group. */
    piPrelude(c: Command, id: string): boolean {
      if (["model.set", "thinking.set", "session.compact"].includes(c.type)) {
        idle(id);
        if (store.get("session", id).revision !== c.expectedRevision)
          throw new SuriError("CONFLICT", "Session changed.");
      }
      const observationalRuntimeCommand = [
        "model.list",
        "thinking.list",
        "commands.list",
        "session.tree",
        "session.info",
      ].includes(c.type);
      return observationalRuntimeCommand;
    },
    runtimeUnavailable() {
      return new SuriError(
        "RUNTIME_UNAVAILABLE",
        "Runtime metadata is unavailable until you explicitly resume this session.",
      );
    },
    /** Result transformations that need no further request. */
    piResult(c: Command, builtins: Data[], result: Data): Data {
      if (c.type === "session.tree") result = this.sessionTree(result);
      if (c.type === "commands.list")
        result = this.commandsList(builtins, result);
      return result;
    },
    piBuiltins() {
      return builtinSlashCommands.map(([name, description, supported]) => ({
        name,
        description,
        source: "builtin",
        supported,
      }));
    },
    /** Method and parameters of the generic Pi request for a runtime command. */
    piRequestArgs(c: Command, p: Data): [string, Data] {
      const map: Data = {
        "thinking.list": "get_available_thinking_levels",
        "commands.list": "get_commands",
        "model.set": "set_model",
        "thinking.set": "set_thinking_level",
        "session.compact": "compact",
        "session.tree": "get_tree",
        "session.info": "get_session_stats",
      };
      return [
        map[c.type],
        c.type === "model.set"
          ? {
              provider: requiredString(p, "provider"),
              modelId: requiredString(p, "id"),
            }
          : c.type === "thinking.set"
            ? { level: requiredString(p, "level") }
            : c.type === "session.compact"
              ? { customInstructions: p.instructions }
              : {},
      ];
    },
    sessionTree(result: Data): Data {
      const entries: Data[] = [];
      const visit = (nodes: Data[], depth = 0) => {
        if (depth > 256) return;
        for (const n of nodes) {
          const e = n.entry ?? {};
          entries.push({
            entryId: String(e.id ?? ""),
            parentId: e.parentId ?? null,
            role: e.message?.role ?? e.type,
            label: String(
              n.label ??
                e.message?.content?.find?.((b: Data) => b.type === "text")
                  ?.text ??
                e.type ??
                "Entry",
            ).slice(0, 200),
            activeLeaf: e.id === result.leafId,
          });
          visit(n.children ?? [], depth + 1);
        }
      };
      visit(result.tree ?? []);
      result = { entries };
      return result;
    },
    commandsList(builtins: Data[], result: Data): Data {
      result = {
        commands: [
          ...builtins,
          ...(result.commands ?? []).map((entry: Data) => ({
            name: String(entry.name ?? ""),
            description: String(entry.description ?? "").slice(0, 500),
            source: ["extension", "prompt", "skill"].includes(entry.source)
              ? entry.source
              : "unknown",
            supported: true,
            location: ["user", "project", "path"].includes(
              entry.sourceInfo?.location ?? entry.location,
            )
              ? (entry.sourceInfo?.location ?? entry.location)
              : undefined,
          })),
        ],
      };
      return result;
    },
    /** Applies the confirmed model after the awaited `get_state` request. */
    modelSetApply(c: Command, id: string, state: Data): Data {
      let result: Data = {};
      const observed = state.model;
      if (
        !observed ||
        typeof observed.provider !== "string" ||
        !observed.provider ||
        typeof observed.id !== "string" ||
        !observed.id
      )
        throw new SuriError(
          "UPSTREAM_REJECTED",
          "Pi did not confirm the selected model.",
        );
      result = { provider: observed.provider, id: observed.id };
      const changed = store.patch("session", id, c.expectedRevision, {
        model: result,
      });
      const workspace = store.get("workspace", changed.workspaceId);
      const project = store.get("project", workspace.projectId);
      store.put("project", {
        ...project,
        lastModelByRuntime: {
          ...(project.lastModelByRuntime ?? {}),
          [changed.runtimeId]: result,
        },
      });
      result = { ...result, revision: changed.revision };
      publish("catalog", "catalog.session", changed);
      return result;
    },
    /** Applies the confirmed thinking level after the awaited `get_state` request. */
    thinkingSetApply(c: Command, id: string, state: Data): Data {
      let result: Data = {};
      if (typeof state.thinkingLevel !== "string" || !state.thinkingLevel)
        throw new SuriError(
          "UPSTREAM_REJECTED",
          "Pi did not confirm the selected thinking level.",
        );
      result = { level: state.thinkingLevel };
      const changed = store.patch("session", id, c.expectedRevision, {
        thinkingLevel: state.thinkingLevel,
      });
      const workspace = store.get("workspace", changed.workspaceId);
      const project = store.get("project", workspace.projectId);
      store.put("project", {
        ...project,
        lastThinkingByRuntime: {
          ...(project.lastThinkingByRuntime ?? {}),
          [changed.runtimeId]: state.thinkingLevel,
        },
      });
      result = { ...result, revision: changed.revision };
      publish("catalog", "catalog.session", changed);
      return result;
    },
  };
}
