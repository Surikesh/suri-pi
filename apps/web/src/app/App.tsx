import { useSyncExternalStore } from "react";
import type { Data } from "../../../../packages/protocol/src/index.js";
import { store, select } from "../store.js";
import {
  useScrollRestoration,
  useTranscriptFollow,
} from "../features/transcript/index.js";
import {
  useFileMenu,
  useSessionProjectMenus,
} from "../features/menus/index.js";
import {
  createNewSessionController,
  useNewSessionState,
} from "../features/dialogs/index.js";
import {
  useComposer,
  useDraftRestored,
  useSend,
} from "../features/composer/index.js";
import { useSidebarNavigation } from "../features/sidebar/index.js";
import { builtinCommandNames, builtinCommands } from "./builtin-commands.js";
import { createRunBuiltin } from "./run-builtin.js";
import { AppLayout } from "./app-layout.js";
import { AppDetails, AppMain } from "./app-main.js";
import { AppOverlays } from "./app-overlays.js";
import { createSessionActions } from "./session-actions.js";
import {
  useComposerFields,
  useDialogState,
  useHistoryState,
  useScrollRefs,
  useShellState,
} from "./use-app-state.js";
import { useChangePreview } from "./use-change-preview.js";
import { useFileActions } from "./use-file-actions.js";
import {
  useGlobalShortcuts,
  useModalFocusTrap,
} from "./use-global-shortcuts.js";
import { useNarrow, useShellLayout } from "./use-layout.js";
import { useModelCatalog, useModelDiscovery } from "./use-model-catalog.js";
import { usePreferences } from "./use-preferences.js";
import {
  useDraftSync,
  useProjectIconDiscovery,
  useSelectionReset,
  useWorkspaceSync,
} from "./use-selection-sync.js";
import { useSessionView } from "./use-session-view.js";
import { useUpdateBridge } from "./use-update-bridge.js";
import { useUsage } from "./use-usage.js";

declare global {
  interface Window {
    suriFlush?: () => Promise<void>;
    suriImportFiles?: (files: Data[]) => Promise<void>;
    webkit?: { messageHandlers: { suri: { postMessage: (p: Data) => void } } };
  }
}

export function App() {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const narrow = useNarrow();
  const shell = useShellState();
  const dialogs = useDialogState();
  const { composerState, previewImage, closeAttachmentPreview } =
    useComposerFields();
  const history = useHistoryState(state);
  const scrollRefs = useScrollRefs(state);
  const newSession = useNewSessionState();
  const { newSessionDialog } = newSession;
  const fileMenuState = useFileMenu();
  const menus = useSessionProjectMenus();
  const { setDraft, setAttachments, attachmentPreview } = composerState;
  const { latestRef, scrollWriter, cancelScrollRestoration } = scrollRefs;
  useShellLayout({
    state,
    draft: composerState.draft,
    editor: shell.editor,
    composerRail: scrollRefs.composerRail,
    updateComposerClearance: scrollRefs.updateComposerClearance,
    viewOptions: shell.viewOptions,
    setViewOptions: shell.setViewOptions,
    viewOptionsTrigger: shell.viewOptionsTrigger,
  });
  const prefsState = usePreferences({ state });
  const { prefsRef, patchPreferences } = prefsState;
  useProjectIconDiscovery({ state });
  const view = useSessionView({ state, visibleOlder: history.visibleOlder });
  const { session, projection, workspace, running, queueable } = view;
  const catalogState = useModelCatalog({ state, session });
  const changePreview = useChangePreview({
    state,
    workspace,
    fileMenu: fileMenuState.fileMenu,
  });
  const files = useFileActions({
    state,
    workspace,
    fileMenuState,
    dialogs,
    shell,
    dismissChangePreview: changePreview.dismissChangePreview,
  });
  const usage = useUsage({ state, session, projection, setDraft });
  useWorkspaceSync({
    state,
    session,
    projection,
    setLinkedFile: dialogs.setLinkedFile,
    fileMenuState,
  });
  const { scroll } = useTranscriptFollow({ latestRef });
  useSelectionReset({
    state,
    history,
    scrollRefs,
    dialogs,
    composerState,
    setModels: catalogState.setModels,
  });
  const restoration = useScrollRestoration({
    state,
    projection,
    historyOwner: history.historyOwner,
    scroll,
    latestRef,
    scrollWriter,
    cancelScrollRestoration,
  });
  useDraftRestored({ state, setDraft, setAttachments });
  useModalFocusTrap({
    dialogs,
    attachmentPreview,
    newSessionDialog,
    projection,
  });
  const composerApi = useComposer({
    state,
    session,
    workspace,
    projection,
    composerState,
    builtinCommands,
    builtinCommandNames,
  });
  const { act, create } = createSessionActions({
    state,
    session,
    workspace,
    projection,
    running,
    shell,
    dialogs,
    composerState,
  });
  const newSessionController = createNewSessionController({
    state,
    newSession,
    currentProject: view.currentProject,
    setDirectoryDialog: dialogs.setDirectoryDialog,
    act,
    create,
  });
  const { openNewSessionDialog, closeNewSessionDialog } = newSessionController;
  const { loadModels } = useModelDiscovery({
    state,
    session,
    running,
    projection,
    catalog: catalogState.catalog,
    discovery: catalogState.discovery,
    catalogGeneration: catalogState.catalogGeneration,
    catalogKey: catalogState.catalogKey,
    sourceSignature: catalogState.sourceSignature,
    catalogIdentity: catalogState.catalogIdentity,
    prefetchFailure: catalogState.prefetchFailure,
    setModels: catalogState.setModels,
    setPrefetchFailure: catalogState.setPrefetchFailure,
  });
  const runBuiltin = createRunBuiltin({
    session,
    running,
    state,
    workspace,
    prefsRef,
    conversationMessages: view.conversationMessages,
    focusNewSession: shell.focusNewSession,
    historyInput: dialogs.historyInput,
    search: shell.search,
    scopeToken: dialogs.scopeToken,
    setSettings: dialogs.setSettings,
    setModelOpenSignal: dialogs.setModelOpenSignal,
    setThinkingOpenSignal: dialogs.setThinkingOpenSignal,
    setScopeDraft: dialogs.setScopeDraft,
    setScopeSearch: dialogs.setScopeSearch,
    setScopeOffset: dialogs.setScopeOffset,
    setScopePanel: dialogs.setScopePanel,
    setScopePhase: dialogs.setScopePhase,
    setScopeError: dialogs.setScopeError,
    setTreeSessionId: dialogs.setTreeSessionId,
    setTree: dialogs.setTree,
    setUtilityPanel: dialogs.setUtilityPanel,
    setSessionMenuRenaming: menus.setSessionMenuRenaming,
    setSidebar: shell.setSidebar,
    loadModels,
    openSessionMenu: menus.openSessionMenu,
    openNewSessionDialog,
    select,
  });
  const { send } = useSend({
    state,
    session,
    running,
    queueable,
    editor: shell.editor,
    runBuiltin,
    saveDraft: composerApi.saveDraft,
    composerState,
    builtinCommandNames,
  });
  useUpdateBridge({
    state,
    session,
    workspace,
    shell,
    dialogs,
    history,
    composerState,
  });
  useDraftSync({ state, session, composerState, shell });
  useGlobalShortcuts({
    state,
    session,
    projection,
    shell,
    dialogs,
    menus,
    attachmentPreview,
    closeAttachmentPreview,
    newSessionDialog,
    openNewSessionDialog,
    closeNewSessionDialog,
    prefsRef,
    patchPreferences,
    act,
  });
  const navigation = useSidebarNavigation({
    state,
    filter: shell.filter,
    archived: shell.archived,
    prefs: prefsState.prefs,
    prefsRef,
    patchPreferences,
    act,
    dragSource: shell.dragSource,
    dropMarker: shell.dropMarker,
    setSessionTooltip: shell.setSessionTooltip,
    sessionTooltipTimer: shell.sessionTooltipTimer,
    sessionTooltipRequest: shell.sessionTooltipRequest,
  });
  return (
    <AppLayout
      state={state}
      session={session}
      navigation={navigation}
      narrow={narrow}
      shell={shell}
      dialogs={dialogs}
      prefsState={prefsState}
      menus={menus}
      openNewSessionDialog={openNewSessionDialog}
      addFiles={composerApi.addFiles}
      act={act}
      create={create}
    >
      <AppMain
        state={state}
        view={view}
        narrow={narrow}
        shell={shell}
        dialogs={dialogs}
        history={history}
        scrollRefs={scrollRefs}
        scroll={scroll}
        restoration={restoration}
        fileMenuState={fileMenuState}
        menus={menus}
        files={files}
        composerState={composerState}
        previewImage={previewImage}
        composerApi={composerApi}
        send={send}
        catalogState={catalogState}
        loadModels={loadModels}
        prefsState={prefsState}
        usage={usage}
        newSession={newSession}
        newSessionController={newSessionController}
        act={act}
        create={create}
      />
      <AppDetails
        workspace={workspace}
        shell={shell}
        dialogs={dialogs}
        prefsState={prefsState}
        changePreview={changePreview}
        pinChange={files.pinChange}
      />
      <AppOverlays
        state={state}
        view={view}
        shell={shell}
        dialogs={dialogs}
        menus={menus}
        fileMenuState={fileMenuState}
        files={files}
        attachmentPreview={attachmentPreview}
        closeAttachmentPreview={closeAttachmentPreview}
        models={catalogState.models}
        loadModels={loadModels}
        prefsState={prefsState}
        act={act}
        create={create}
      />
    </AppLayout>
  );
}
