import { useEffect, useRef } from "react";
import type { Data } from "../../../../packages/protocol/src/index.js";
import { command, connect, refresh, report, type State } from "../store.js";
import { viewStorage as localStorage } from "../view-storage.js";
import type { useFileMenu } from "../features/menus/index.js";
import type {
  ComposerStateValue,
  DialogState,
  HistoryState,
  ScrollRefs,
  ShellState,
} from "./use-app-state.js";
import type { SessionView } from "./use-session-view.js";

export function useProjectIconDiscovery({ state }: { state: State }) {
  const discoveringIcons = useRef(new Set<string>());
  useEffect(() => {
    if (!state.ready) return;
    for (const project of state.catalog.projects) {
      if (discoveringIcons.current.has(project.id)) continue;
      discoveringIcons.current.add(project.id);
      void command("project.discoverIcon", { projectId: project.id })
        .then(refresh)
        .catch(report);
    }
  }, [state.ready, state.catalog.projects]);
}

export function useWorkspaceSync({
  state,
  session,
  projection,
  setLinkedFile,
  fileMenuState,
}: {
  state: State;
  session: SessionView["session"];
  projection: SessionView["projection"];
  setLinkedFile: DialogState["setLinkedFile"];
  fileMenuState: ReturnType<typeof useFileMenu>;
}) {
  const { setFileMenu, setFileMenuStatus } = fileMenuState;
  useEffect(() => {
    const linkedTarget = (path: unknown) => {
      if (typeof path !== "string") return undefined;
      const owner = state.catalog.workspaces
        .filter(
          (candidate: Data) =>
            path === candidate.root || path.startsWith(candidate.root + "/"),
        )
        .sort((a: Data, b: Data) => b.root.length - a.root.length)[0];
      return owner
        ? {
            workspace: owner,
            path: path === owner.root ? "." : path.slice(owner.root.length + 1),
          }
        : { workspace: undefined, path };
    };
    const open = (event: Event) => {
      const { path, line } = (event as CustomEvent).detail;
      const target = linkedTarget(path);
      if (!target) return;
      if (!target.workspace) {
        window.open(
          `https://herdr-local-file.invalid/open?path=${encodeURIComponent(target.path)}`,
          "_blank",
          "noopener",
        );
        return;
      }
      setLinkedFile({
        workspaceId: target.workspace.id,
        path: target.path,
        line,
      });
    };
    const menu = (event: Event) => {
      const { path, x, y, trigger } = (event as CustomEvent).detail;
      const target = linkedTarget(path);
      if (!target || !(trigger instanceof HTMLElement)) return;
      setFileMenuStatus("");
      setFileMenu({
        path: target.path,
        absolutePath: path,
        workspaceId: target.workspace?.id,
        trigger,
        source: "transcript",
        x: Math.max(8, Math.min(Number(x) || 8, innerWidth - 236)),
        y: Math.max(8, Math.min(Number(y) || 8, innerHeight - 300)),
      });
    };
    window.addEventListener("suri-open-file", open);
    window.addEventListener("suri-file-menu", menu);
    return () => {
      window.removeEventListener("suri-open-file", open);
      window.removeEventListener("suri-file-menu", menu);
    };
  }, [state.catalog.workspaces]);
  useEffect(() => {
    void connect();
  }, []);
  useEffect(() => {
    if (!session || projection.seq <= (session.lastReadSeq ?? 0)) return;
    const timer = setTimeout(
      () =>
        void command(
          "session.read",
          { throughSeq: projection.seq },
          session.id,
        ).catch(report),
      120,
    );
    return () => clearTimeout(timer);
  }, [session?.id, projection.seq]);
}

export function useSelectionReset({
  state,
  history,
  scrollRefs,
  dialogs,
  composerState,
  setModels,
}: {
  state: State;
  history: HistoryState;
  scrollRefs: ScrollRefs;
  dialogs: DialogState;
  composerState: ComposerStateValue;
  setModels: (models: Data[]) => void;
}) {
  const {
    historyRequest,
    historyCache,
    setOlder,
    setHistoryCursor,
    setHistoryOwner,
    setHistoryLoading,
    setDismissedNotices,
  } = history;
  const { scrollWriter, lastScrollMetrics, setAtLatest } = scrollRefs;
  const { setTree, scopeToken, setScopePanel } = dialogs;
  const {
    setDraft,
    setAttachmentPreview,
    setLevels,
    setCommands,
    setCommandsOffline,
    setContextResults,
    completionClosedRef,
    setCompletionClosed,
    setAttachments,
  } = composerState;
  useEffect(() => {
    scrollWriter.current?.cancel();
    lastScrollMetrics.current = undefined;
    setDraft(localStorage.getItem(`suri.draft.${state.selected}`) ?? "");
    setAttachmentPreview(undefined);
    historyRequest.current++;
    const cachedHistory = historyCache.current.get(state.selected ?? "");
    setOlder(cachedHistory?.messages ?? []);
    setHistoryCursor(cachedHistory?.cursor);
    setHistoryOwner(state.selected);
    setHistoryLoading(false);
    setDismissedNotices(new Set());
    setTree([]);
    scopeToken.current++;
    setScopePanel(false);
    setModels([]);
    setLevels([]);
    setCommands(undefined);
    setCommandsOffline(false);
    setContextResults([]);
    completionClosedRef.current = false;
    setCompletionClosed(false);
    const atLatest =
      localStorage.getItem(`suri.scroll.${state.selected}`) === null;
    setAtLatest(atLatest);
    setAttachments(
      JSON.parse(
        localStorage.getItem(`suri.attachments.${state.selected}`) ?? "[]",
      ),
    );
  }, [state.selected]);
}

export function useDraftSync({
  state,
  session,
  composerState,
  shell,
}: {
  state: State;
  session: SessionView["session"];
  composerState: ComposerStateValue;
  shell: ShellState;
}) {
  const { setLoadedDraft, setDraft, setAttachments, loadedDraft } =
    composerState;
  const { focusNewSession, editor } = shell;
  useEffect(() => {
    setLoadedDraft(undefined);
    if (!state.ready || !state.selected || !session) return;
    let cancelled = false;
    void command("draft.get", {}, state.selected)
      .then((saved) => {
        if (cancelled) return;
        if (localStorage.getItem(`suri.draft.${state.selected}`) === null) {
          setDraft(saved.text);
          localStorage.setItem(`suri.draft.${state.selected}`, saved.text);
          if (saved.attachmentIds?.length)
            setAttachments(saved.attachments ?? []);
        }
        setLoadedDraft(state.selected);
      })
      .catch((error) => {
        if (cancelled) return;
        setLoadedDraft(state.selected);
        report(error);
      });
    return () => {
      cancelled = true;
    };
  }, [state.ready, state.selected, session?.id]);
  useEffect(() => {
    if (!focusNewSession.current || !session) return;
    if (session.id !== focusNewSession.current) return;
    if (loadedDraft !== session.id) return;
    const frame = requestAnimationFrame(() => {
      if (state.selected !== focusNewSession.current) return;
      editor.current?.focus();
      focusNewSession.current = undefined;
    });
    return () => cancelAnimationFrame(frame);
  }, [session?.id, loadedDraft, state.selected]);
}
