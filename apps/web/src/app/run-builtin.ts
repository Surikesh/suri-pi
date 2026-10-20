import {
  type Data,
  type Message,
} from "../../../../packages/protocol/src/index.js";
import { command, type State } from "../store.js";
import {
  nextSessionPrompt,
  parseNextSessionArgument,
} from "../next-session.js";

type Setter<T> = (value: T | ((old: T) => T)) => void;

interface RunBuiltinDeps {
  session: Data | undefined;
  running: boolean;
  state: State;
  workspace: Data | undefined;
  prefsRef: { current: Data };
  conversationMessages: Message[];
  focusNewSession: { current: string | undefined };
  historyInput: { current: HTMLInputElement | null };
  search: { current: HTMLInputElement | null };
  scopeToken: { current: number };
  setSettings: Setter<boolean>;
  setModelOpenSignal: Setter<number>;
  setThinkingOpenSignal: Setter<number>;
  setScopeDraft: Setter<string[] | null>;
  setScopeSearch: Setter<string>;
  setScopeOffset: Setter<number>;
  setScopePanel: Setter<boolean>;
  setScopePhase: Setter<"loading" | "ready" | "error">;
  setScopeError: Setter<string>;
  setTreeSessionId: Setter<string | undefined>;
  setTree: Setter<Data[]>;
  setUtilityPanel: Setter<
    { title: string; rows: Array<[string, string]> } | undefined
  >;
  setSessionMenuRenaming: Setter<boolean>;
  setSidebar: Setter<boolean>;
  loadModels: (session: Data, force: boolean) => Promise<unknown>;
  openSessionMenu: (
    session: Data,
    trigger: HTMLElement,
    x: number,
    y: number,
  ) => void;
  openNewSessionDialog: (trigger?: HTMLElement) => void;
  select: (id: string) => void;
}

export function createRunBuiltin({
  session,
  running,
  state,
  workspace,
  prefsRef,
  conversationMessages,
  focusNewSession,
  historyInput,
  search,
  scopeToken,
  setSettings,
  setModelOpenSignal,
  setThinkingOpenSignal,
  setScopeDraft,
  setScopeSearch,
  setScopeOffset,
  setScopePanel,
  setScopePhase,
  setScopeError,
  setTreeSessionId,
  setTree,
  setUtilityPanel,
  setSessionMenuRenaming,
  setSidebar,
  loadModels,
  openSessionMenu,
  openNewSessionDialog,
  select,
}: RunBuiltinDeps) {
  return async (name: string, argument: string) => {
    if (!session && !["new", "settings", "quit"].includes(name))
      throw Error("Select a session first.");
    switch (name) {
      case "settings":
        setSettings(true);
        return;
      case "model":
        if (running)
          throw Error("Wait for Pi to finish before changing model.");
        setModelOpenSignal((value) => value + 1);
        return;
      case "thinking":
        if (running)
          throw Error("Wait for Pi to finish before changing thinking level.");
        setThinkingOpenSignal((value) => value + 1);
        return;
      case "scoped-models": {
        if (running)
          throw Error("Wait for Pi to finish before changing model scope.");
        setScopeDraft(
          Array.isArray(prefsRef.current.values.scopedModels)
            ? [...prefsRef.current.values.scopedModels]
            : null,
        );
        setScopeSearch("");
        setScopeOffset(0);
        setScopePanel(true);
        const current = ++scopeToken.current;
        setScopePhase("loading");
        void loadModels(session!, false)
          .then(() => {
            if (scopeToken.current === current) setScopePhase("ready");
          })
          .catch((cause) => {
            if (scopeToken.current === current) {
              setScopeError((cause as Error).message);
              setScopePhase("error");
            }
          });
        return;
      }
      case "tree":
      case "fork":
        if (running) throw Error("Wait for Pi to finish before forking.");
        setSettings(true);
        setTreeSessionId(session!.id);
        setTree((await command("session.tree", {}, session!.id)).entries ?? []);
        return;
      case "import":
        if (running) throw Error("Wait for Pi to finish before importing.");
        historyInput.current?.click();
        return;
      case "copy": {
        const last = [...conversationMessages]
          .reverse()
          .find((message) => message.role === "assistant");
        if (!last) throw Error("There is no Pi message to copy yet.");
        await navigator.clipboard.writeText(
          last.blocks.map((block) => block.text ?? "").join("\n"),
        );
        return;
      }
      case "export": {
        if (running) throw Error("Wait for Pi to finish before exporting.");
        const artifact = await command("session.export", {}, session!.id);
        const link = document.createElement("a");
        link.href = `/v1/assets/${artifact.id}?download=1`;
        link.download = artifact.name ?? "Pi session.html";
        link.click();
        return;
      }
      case "session": {
        const stats = await command("session.info", {}, session!.id);
        setUtilityPanel({
          title: "Session information",
          rows: [
            ["Session ID", session!.id],
            ["Project", workspace?.label ?? "Unknown"],
            ["Model", session!.model?.id ?? "Not selected"],
            ["Reasoning", session!.thinkingLevel ?? "Not selected"],
            ["Messages", String(stats.totalMessages ?? 0)],
            ["Tool calls", String(stats.toolCalls ?? 0)],
            [
              "Context",
              stats.contextUsage?.percent == null
                ? "Unavailable"
                : `${stats.contextUsage.percent}%`,
            ],
          ],
        });
        return;
      }
      case "hotkeys":
        setUtilityPanel({
          title: "Keyboard shortcuts",
          rows: [
            ["⌃⌥N", "Choose a project for a new session"],
            ["⌘K", "Search projects and sessions"],
            ["⌃⌥L", "Switch between Projects and List"],
            ["⌘1–9", "Open a numbered visible session"],
            ["Enter", "Send"],
            ["Shift–Enter", "New line"],
            ["Escape", "Close menu or panel"],
            ["Arrow keys", "Navigate menus and resize the sidebar"],
          ],
        });
        return;
      case "changelog": {
        const runtime = state.catalog.runtimes.find(
          (item: Data) => item.id === session!.runtimeId,
        );
        setUtilityPanel({
          title: "Pi runtime",
          rows: [
            ["Version", runtime?.version ?? "Unknown"],
            ["Compatibility", runtime?.status ?? "Unknown"],
            ["Updates", "Pi updates are pinned and validated by Suri"],
          ],
        });
        return;
      }
      case "name":
        if (!argument.trim()) {
          const trigger = document.querySelector<HTMLElement>(".session-title");
          if (trigger) {
            const rect = trigger.getBoundingClientRect();
            openSessionMenu(session!, trigger, rect.left, rect.bottom);
            setSessionMenuRenaming(true);
          }
          return;
        }
        await command(
          "session.rename",
          { name: argument.trim() },
          session!.id,
          session!.revision,
        );
        return;
      case "clone":
        if (running) throw Error("Wait for Pi to finish before cloning.");
        await command("session.clone", {}, session!.id, session!.revision);
        return;
      case "new":
        openNewSessionDialog();
        return;
      case "next-session": {
        if (running)
          throw Error(
            "Wait for Pi to finish before starting the next session.",
          );
        if (!workspace) throw Error("Select a project workspace first.");
        const request = parseNextSessionArgument(argument);
        await command("file.read", {
          workspaceId: workspace.id,
          path: request.planPath,
          offset: 0,
          length: 1,
        });
        const prompt = nextSessionPrompt(request.planPath);
        if (request.dryRun) {
          setUtilityPanel({
            title: "Next session preview",
            rows: [
              ["Name", request.name],
              ["Plan", request.planPath],
              ["Prompt", prompt],
            ],
          });
          return;
        }
        const created = await command("session.create", {
          workspaceId: workspace.id,
          runtimeId: session!.runtimeId,
          name: request.name,
        });
        await command(
          "run.submit",
          { mode: "prompt", text: prompt, attachmentIds: [] },
          created.id,
        );
        focusNewSession.current = created.id;
        select(created.id);
        setSidebar(false);
        return;
      }
      case "compact":
        if (running) throw Error("Wait for Pi to finish before compacting.");
        await command(
          "session.compact",
          argument.trim() ? { instructions: argument.trim() } : {},
          session!.id,
          session!.revision,
        );
        return;
      case "resume":
        setSidebar(true);
        requestAnimationFrame(() => search.current?.focus());
        return;
      case "reload":
        if (running) throw Error("Wait for Pi to finish before reloading.");
        await command("session.reload", {}, session!.id);
        return;
      case "login":
      case "logout":
        throw Error(
          `/${name}: manage credentials directly in Pi outside Suri, then resume here. Suri never reads or copies credentials.`,
        );
      case "share":
        throw Error(
          "/share requires an explicit external publishing flow in Pi. Nothing was uploaded.",
        );
      case "trust":
        throw Error(
          "/trust: review extension trust directly in Pi, then reload this idle session. Suri does not change global Pi settings.",
        );
      case "quit":
        if (!window.webkit)
          throw Error("Quit is available in the Suri Pi app.");
        window.webkit.messageHandlers.suri.postMessage({ type: "quit" });
        return;
      default:
        throw Error(
          `/${name} is a Pi command, but its safe Suri UI flow is not implemented yet. It was not sent as a prompt.`,
        );
    }
  };
}
