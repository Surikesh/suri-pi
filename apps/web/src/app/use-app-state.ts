import type React from "react";
import { useCallback, useRef, useState } from "react";
import type { Data, Message } from "../../../../packages/protocol/src/index.js";
import { createScrollPositionWriter } from "../scroll-position.js";
import type { State } from "../store.js";
import { viewStorage as localStorage } from "../view-storage.js";

const EMPTY_HISTORY: Message[] = [];

export function useShellState() {
  const [filter, setFilter] = useState("");
  const [sidebar, setSidebar] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(
    localStorage.getItem("suri.sidebarCollapsed") === "true",
  );
  const navigationToggle = useRef<HTMLButtonElement>(null);
  const dragSource = useRef("");
  const [dropMarker, setDropMarker] = useState<{ key: string; edge: string }>();
  const endNavigationDrag = () => {
    dragSource.current = "";
    setDropMarker(undefined);
  };
  const startNavigationDrag = (
    event: React.DragEvent,
    source: string,
    row: HTMLElement,
  ) => {
    event.stopPropagation();
    dragSource.current = source;
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", source);
    const preview = row.cloneNode(true) as HTMLElement;
    preview.classList.add("navigation-drag-preview");
    preview.style.width = `${Math.min(row.getBoundingClientRect().width, 280)}px`;
    document.body.append(preview);
    event.dataTransfer.setDragImage(preview, 16, 14);
    setTimeout(() => preview.remove(), 0);
  };
  const [details, setDetailsState] = useState(
    localStorage.getItem("suri.details") === "true",
  );
  const [terminalExecution, setTerminalExecution] = useState<
    { id: string; workspaceId: string; command: string } | undefined
  >();
  const setDetails = (value: boolean) => {
    setDetailsState(value);
    localStorage.setItem("suri.details", String(value));
  };
  const focusNewSession = useRef<string | undefined>(undefined);
  const [commandHeld, setCommandHeld] = useState(false);
  const viewOptionsTrigger = useRef<HTMLButtonElement>(null);
  const [viewOptions, setViewOptions] = useState(false);
  const [sessionTooltip, setSessionTooltip] = useState<
    | {
        sessionId: string;
        x: number;
        y: number;
        excerpt?: string;
        speaker?: "Pi" | "You";
        loaded: boolean;
      }
    | undefined
  >();
  const sessionTooltipTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const sessionTooltipRequest = useRef(0);
  const [archived, setArchived] = useState(false);
  const editor = useRef<HTMLTextAreaElement>(null);
  const search = useRef<HTMLInputElement>(null);
  return {
    filter,
    setFilter,
    sidebar,
    setSidebar,
    sidebarCollapsed,
    setSidebarCollapsed,
    navigationToggle,
    dragSource,
    dropMarker,
    setDropMarker,
    endNavigationDrag,
    startNavigationDrag,
    details,
    setDetails,
    terminalExecution,
    setTerminalExecution,
    focusNewSession,
    commandHeld,
    setCommandHeld,
    viewOptionsTrigger,
    viewOptions,
    setViewOptions,
    sessionTooltip,
    setSessionTooltip,
    sessionTooltipTimer,
    sessionTooltipRequest,
    archived,
    setArchived,
    editor,
    search,
  };
}

export function useDialogState() {
  const [settings, setSettings] = useState(false);
  const [utilityPanel, setUtilityPanel] = useState<
    { title: string; rows: Array<[string, string]> } | undefined
  >();
  const [scopePanel, setScopePanel] = useState(false);
  const [scopeDraft, setScopeDraft] = useState<string[] | null>(null);
  const [scopeSearch, setScopeSearch] = useState("");
  const [scopePhase, setScopePhase] = useState<"loading" | "ready" | "error">(
    "loading",
  );
  const [scopeError, setScopeError] = useState("");
  const [scopeOffset, setScopeOffset] = useState(0);
  const scopeToken = useRef(0);
  const historyInput = useRef<HTMLInputElement>(null);
  const [importPreview, setImportPreview] = useState<Data[]>([]);
  const [importing, setImporting] = useState(false);
  const [treeSessionId, setTreeSessionId] = useState<string>();
  const [tree, setTree] = useState<Data[]>([]);
  const [worktrees, setWorktrees] = useState<Data[]>([]);
  const [linkedFile, setLinkedFile] = useState<Data>();
  const [requestedChange, setRequestedChange] = useState<
    { path: string; requestId: number } | undefined
  >();
  const [requestedFile, setRequestedFile] = useState<
    { path: string; requestId: number } | undefined
  >();
  const [directoryDialog, setDirectoryDialog] = useState<
    Data | null | undefined
  >();
  const [catalogDialog, setCatalogDialog] = useState<Data | null | undefined>();
  const iconInput = useRef<HTMLInputElement>(null);
  const [iconTarget, setIconTarget] = useState<Data | undefined>();
  const [modelOpenSignal, setModelOpenSignal] = useState(0);
  const [thinkingOpenSignal, setThinkingOpenSignal] = useState(0);
  return {
    settings,
    setSettings,
    utilityPanel,
    setUtilityPanel,
    scopePanel,
    setScopePanel,
    scopeDraft,
    setScopeDraft,
    scopeSearch,
    setScopeSearch,
    scopePhase,
    setScopePhase,
    scopeError,
    setScopeError,
    scopeOffset,
    setScopeOffset,
    scopeToken,
    historyInput,
    importPreview,
    setImportPreview,
    importing,
    setImporting,
    treeSessionId,
    setTreeSessionId,
    tree,
    setTree,
    worktrees,
    setWorktrees,
    linkedFile,
    setLinkedFile,
    requestedChange,
    setRequestedChange,
    requestedFile,
    setRequestedFile,
    directoryDialog,
    setDirectoryDialog,
    catalogDialog,
    setCatalogDialog,
    iconInput,
    iconTarget,
    setIconTarget,
    modelOpenSignal,
    setModelOpenSignal,
    thinkingOpenSignal,
    setThinkingOpenSignal,
  };
}

export function useComposerFields() {
  const [draft, setDraft] = useState("");
  const [loadedDraft, setLoadedDraft] = useState<string | undefined>();
  const [attachments, setAttachments] = useState<Data[]>([]);
  const [attachmentPreview, setAttachmentPreview] = useState<Data>();
  const fileInput = useRef<HTMLInputElement>(null);
  const [levels, setLevels] = useState<string[]>([]);
  const [commands, setCommands] = useState<Data[] | undefined>();
  const [commandsOffline, setCommandsOffline] = useState(false);
  const [commandActive, setCommandActive] = useState(0);
  const [contextResults, setContextResults] = useState<string[]>([]);
  const [contextActive, setContextActive] = useState(0);
  const [contextLoading, setContextLoading] = useState(false);
  const [completionClosed, setCompletionClosed] = useState(false);
  const completionClosedRef = useRef(false);
  const [busy, setBusy] = useState(false);
  const previewImage = useCallback(
    (asset: Data, trigger: HTMLElement) =>
      setAttachmentPreview({ asset, trigger }),
    [],
  );
  const closeAttachmentPreview = () => {
    const trigger = attachmentPreview?.trigger as HTMLElement | undefined;
    setAttachmentPreview(undefined);
    requestAnimationFrame(() => trigger?.focus());
  };
  const composerState = {
    draft,
    setDraft,
    loadedDraft,
    setLoadedDraft,
    attachments,
    setAttachments,
    attachmentPreview,
    setAttachmentPreview,
    fileInput,
    levels,
    setLevels,
    commands,
    setCommands,
    commandsOffline,
    setCommandsOffline,
    commandActive,
    setCommandActive,
    contextResults,
    setContextResults,
    contextActive,
    setContextActive,
    contextLoading,
    setContextLoading,
    completionClosed,
    setCompletionClosed,
    completionClosedRef,
    busy,
    setBusy,
  };
  return { composerState, previewImage, closeAttachmentPreview };
}

export function useHistoryState(state: State) {
  const [older, setOlder] = useState<Message[]>([]);
  const [historyCursor, setHistoryCursor] = useState<
    number | null | undefined
  >();
  const [historyOwner, setHistoryOwner] = useState<string>();
  const historyCache = useRef(
    new Map<
      string,
      { messages: Message[]; cursor: number | null | undefined }
    >(),
  );
  const visibleOlder = historyOwner === state.selected ? older : EMPTY_HISTORY;
  const visibleHistoryCursor =
    historyOwner === state.selected ? historyCursor : undefined;
  const [historyLoading, setHistoryLoading] = useState(false);
  const historyRequest = useRef(0);
  const latestJumpGeneration = useRef(0);
  const [dismissedNotices, setDismissedNotices] = useState<Set<string>>(
    () => new Set(),
  );
  return {
    older,
    setOlder,
    historyCursor,
    setHistoryCursor,
    historyOwner,
    setHistoryOwner,
    historyCache,
    visibleOlder,
    visibleHistoryCursor,
    historyLoading,
    setHistoryLoading,
    historyRequest,
    latestJumpGeneration,
    dismissedNotices,
    setDismissedNotices,
  };
}

export function useScrollRefs(state: State) {
  const latestRef = useRef(
    localStorage.getItem(`suri.scroll.${state.selected}`) === null,
  );
  const jumpToLatest = useRef<HTMLButtonElement>(null);
  const composerRail = useRef<HTMLDivElement>(null);
  const selectedForScroll = useRef(state.selected);
  selectedForScroll.current = state.selected;
  const scrollWriter = useRef<
    ReturnType<typeof createScrollPositionWriter> | undefined
  >(undefined);
  const cancelScrollRestoration = useRef<(() => void) | undefined>(undefined);
  scrollWriter.current ??= createScrollPositionWriter(
    () => selectedForScroll.current ?? null,
    localStorage,
  );
  const updateComposerClearance = () => {
    const rail = composerRail.current;
    const conversation = rail?.closest<HTMLElement>(".conversation");
    if (!rail || !conversation) return;
    const jump = jumpToLatest.current;
    const jumpHeight =
      jump && !jump.classList.contains("hidden") ? jump.offsetHeight + 4 : 0;
    conversation.style.setProperty(
      "--composer-clearance",
      `${Math.ceil(rail.getBoundingClientRect().height + jumpHeight + 12)}px`,
    );
  };
  const setAtLatest = (value: boolean) => {
    latestRef.current = value;
    const button = jumpToLatest.current;
    if (!button) return;
    button.classList.toggle("hidden", value);
    button.setAttribute("aria-hidden", String(value));
    button.tabIndex = value ? -1 : 0;
    updateComposerClearance();
  };
  const lastScrollMetrics = useRef<{ height: number; top: number } | undefined>(
    undefined,
  );
  return {
    latestRef,
    jumpToLatest,
    composerRail,
    scrollWriter,
    cancelScrollRestoration,
    updateComposerClearance,
    setAtLatest,
    lastScrollMetrics,
  };
}

export type ShellState = ReturnType<typeof useShellState>;
export type DialogState = ReturnType<typeof useDialogState>;
type ComposerFields = ReturnType<typeof useComposerFields>;
export type ComposerStateValue = ComposerFields["composerState"];
export type HistoryState = ReturnType<typeof useHistoryState>;
export type ScrollRefs = ReturnType<typeof useScrollRefs>;
