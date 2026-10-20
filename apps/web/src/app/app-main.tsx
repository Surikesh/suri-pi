import type React from "react";
import type { State } from "../store.js";
import Details from "../workspace-details.js";
import {
  Conversation,
  type ConversationProps,
} from "../features/transcript/index.js";
import { Header } from "../features/header/index.js";
import {
  Composer,
  ComposerStatus,
  QueuePanel,
  UsageFooter,
  useComposer,
  useSend,
} from "../features/composer/index.js";
import {
  NewSessionDialog,
  createNewSessionController,
  useNewSessionState,
} from "../features/dialogs/index.js";
import type {
  useFileMenu,
  useSessionProjectMenus,
} from "../features/menus/index.js";
import { builtinCommandNames, builtinCommands } from "./builtin-commands.js";
import type {
  ComposerStateValue,
  DialogState,
  HistoryState,
  ScrollRefs,
  ShellState,
} from "./use-app-state.js";
import type { PreferencesState } from "./use-preferences.js";
import type { SessionView } from "./use-session-view.js";
import type { useChangePreview } from "./use-change-preview.js";
import type {
  useModelCatalog,
  useModelDiscovery,
} from "./use-model-catalog.js";
import type { useUsage } from "./use-usage.js";
import type { useFileActions } from "./use-file-actions.js";

export function AppMain({
  state,
  view,
  narrow,
  shell,
  dialogs,
  history,
  scrollRefs,
  scroll,
  restoration,
  fileMenuState,
  menus,
  files,
  composerState,
  previewImage,
  composerApi,
  send,
  catalogState,
  loadModels,
  prefsState,
  usage,
  newSession,
  newSessionController,
  act,
  create,
}: {
  state: State;
  view: SessionView;
  narrow: boolean;
  shell: ShellState;
  dialogs: DialogState;
  history: HistoryState;
  scrollRefs: ScrollRefs;
  scroll: ConversationProps["scroll"];
  restoration: {
    readingAnchors: ConversationProps["readingAnchors"];
    restoringScroll: ConversationProps["restoringScroll"];
  };
  fileMenuState: ReturnType<typeof useFileMenu>;
  menus: ReturnType<typeof useSessionProjectMenus>;
  files: ReturnType<typeof useFileActions>;
  composerState: ComposerStateValue;
  previewImage: ConversationProps["previewImage"];
  composerApi: ReturnType<typeof useComposer>;
  send: ReturnType<typeof useSend>["send"];
  catalogState: ReturnType<typeof useModelCatalog>;
  loadModels: ReturnType<typeof useModelDiscovery>["loadModels"];
  prefsState: PreferencesState;
  usage: ReturnType<typeof useUsage>;
  newSession: ReturnType<typeof useNewSessionState>;
  newSessionController: ReturnType<typeof createNewSessionController>;
  act: (fn: () => Promise<unknown>) => Promise<void>;
  create: (workspaceId?: string) => Promise<void>;
}) {
  const {
    session,
    workspace,
    projection,
    running,
    queueable,
    transcriptMessages,
    transcriptItems,
    turnMarks,
    changedByMessage,
  } = view;
  const {
    navigationToggle,
    sidebar,
    sidebarCollapsed,
    setSidebar,
    setSidebarCollapsed,
    search,
    details,
    setDetails,
    editor,
  } = shell;
  const { settings, modelOpenSignal, thinkingOpenSignal } = dialogs;
  const {
    historyOwner,
    visibleHistoryCursor,
    visibleOlder,
    historyLoading,
    setHistoryLoading,
    historyRequest,
    latestJumpGeneration,
    historyCache,
    setOlder,
    setHistoryCursor,
    dismissedNotices,
    setDismissedNotices,
  } = history;
  const {
    latestRef,
    jumpToLatest,
    composerRail,
    scrollWriter,
    cancelScrollRestoration,
    setAtLatest,
    lastScrollMetrics,
  } = scrollRefs;
  const { readingAnchors, restoringScroll } = restoration;
  const { executeInTerminal, pinChange, fileAction } = files;
  const { setFileMenu, setFileMenuStatus } = fileMenuState;
  const { sessionMenu, projectMenu, openSessionMenu } = menus;
  const { draft, setDraft } = composerState;
  const {
    saveDraft,
    slashMatch,
    slashOptions,
    contextMatch,
    addWorkspaceContext,
    addFiles,
  } = composerApi;
  const { catalog, models, prefetchFailure, catalogKey, catalogIdentity } =
    catalogState;
  const { prefs } = prefsState;
  const {
    contextWindow,
    contextTokens,
    contextPercent,
    contextAvailable,
    contextRemaining,
    contextLabel,
    usageEntries,
    detailedUsageAvailable,
    codexConfigured,
    codexUsage,
    codexUsageAvailable,
    codexRemainingPercent,
    codexUsageLabel,
  } = usage;
  const {
    newSessionMatches,
    selectedNewSessionProject,
    closeNewSessionDialog,
    createNewSessionForProject,
  } = newSessionController;
  return (
    <main>
      {state.catalog.runtimeMode === "simulated" && (
        <div className="preview-banner" role="note">
          Test preview — simulated models and replies. This is not your working
          Suri profile.
        </div>
      )}
      <Header
        state={state}
        session={session}
        workspace={workspace}
        navigationToggle={navigationToggle}
        narrow={narrow}
        sidebar={sidebar}
        sidebarCollapsed={sidebarCollapsed}
        setSidebar={setSidebar}
        setSidebarCollapsed={setSidebarCollapsed}
        search={search}
        openSessionMenu={openSessionMenu}
        details={details}
        setDetails={setDetails}
      />

      <Conversation
        state={state}
        session={session}
        workspace={workspace}
        projection={projection}
        historyOwner={historyOwner}
        restoringScroll={restoringScroll}
        readingAnchors={readingAnchors}
        scroll={scroll}
        lastScrollMetrics={lastScrollMetrics}
        latestRef={latestRef}
        scrollWriter={scrollWriter}
        cancelScrollRestoration={cancelScrollRestoration}
        setAtLatest={setAtLatest}
        jumpToLatest={jumpToLatest}
        composerRail={composerRail}
        visibleHistoryCursor={visibleHistoryCursor}
        visibleOlder={visibleOlder}
        historyLoading={historyLoading}
        setHistoryLoading={setHistoryLoading}
        historyRequest={historyRequest}
        latestJumpGeneration={latestJumpGeneration}
        historyCache={historyCache}
        setOlder={setOlder}
        setHistoryCursor={setHistoryCursor}
        transcriptMessages={transcriptMessages}
        transcriptItems={transcriptItems}
        turnMarks={turnMarks}
        changedByMessage={changedByMessage}
        previewImage={previewImage}
        executeInTerminal={executeInTerminal}
        pinChange={pinChange}
        fileAction={fileAction}
        setFileMenu={setFileMenu}
        setFileMenuStatus={setFileMenuStatus}
        draft={draft}
        setDraft={setDraft}
        dismissedNotices={dismissedNotices}
        setDismissedNotices={setDismissedNotices}
        act={act}
        create={create}
      >
        <ComposerStatus
          state={state}
          session={session}
          projection={projection}
          settings={settings}
          sessionMenu={sessionMenu}
          projectMenu={projectMenu}
          act={act}
        />
        <QueuePanel session={session} projection={projection} act={act} />
        <Composer
          state={state}
          session={session}
          projection={projection}
          running={running}
          queueable={queueable}
          editor={editor}
          act={act}
          send={send}
          saveDraft={saveDraft}
          addFiles={addFiles}
          addWorkspaceContext={addWorkspaceContext}
          slashMatch={slashMatch}
          slashOptions={slashOptions}
          contextMatch={contextMatch}
          modelOpenSignal={modelOpenSignal}
          thinkingOpenSignal={thinkingOpenSignal}
          catalogIdentity={catalogIdentity}
          catalog={catalog}
          catalogKey={catalogKey}
          models={models}
          prefetchFailure={prefetchFailure}
          prefs={prefs}
          loadModels={loadModels}
          composerState={composerState}
          builtinCommands={builtinCommands}
          builtinCommandNames={builtinCommandNames}
        />
        <UsageFooter
          session={session}
          contextAvailable={contextAvailable}
          contextTokens={contextTokens}
          contextWindow={contextWindow}
          contextRemaining={contextRemaining}
          contextPercent={contextPercent}
          contextLabel={contextLabel}
          detailedUsageAvailable={detailedUsageAvailable}
          usageEntries={usageEntries}
          codexConfigured={codexConfigured}
          codexUsageAvailable={codexUsageAvailable}
          codexRemainingPercent={codexRemainingPercent}
          codexUsageLabel={codexUsageLabel}
          codexUsage={codexUsage}
        />
      </Conversation>
      <NewSessionDialog
        newSession={newSession}
        newSessionMatches={newSessionMatches}
        selectedNewSessionProject={selectedNewSessionProject}
        closeNewSessionDialog={closeNewSessionDialog}
        createNewSessionForProject={createNewSessionForProject}
      />
    </main>
  );
}

export function AppDetails({
  workspace,
  shell,
  dialogs,
  prefsState,
  changePreview,
  pinChange,
}: {
  workspace: SessionView["workspace"];
  shell: ShellState;
  dialogs: DialogState;
  prefsState: PreferencesState;
  changePreview: ReturnType<typeof useChangePreview>;
  pinChange: (path: string) => void;
}) {
  const { details, setDetails, terminalExecution, setTerminalExecution } =
    shell;
  const { requestedChange, requestedFile } = dialogs;
  const { prefs, prefsRef, setPrefs, patchPreferences } = prefsState;
  const {
    transientChange,
    keepChangePreview,
    dismissChangePreview,
    leaveChangePreview,
  } = changePreview;
  return (
    <>
      {(details || transientChange) && workspace && (
        <Details
          key={workspace.id}
          workspace={workspace}
          close={() => {
            dismissChangePreview();
            if (!transientChange) setDetails(false);
          }}
          transientChange={transientChange}
          onPreviewEnter={keepChangePreview}
          onPreviewLeave={leaveChangePreview}
          onPinChange={pinChange}
          onDismissPreview={dismissChangePreview}
          execution={terminalExecution}
          onExecutionHandled={(id) =>
            setTerminalExecution((current) =>
              current?.id === id ? undefined : current,
            )
          }
          width={prefs.values.detailsWidth ?? 360}
          requestedChange={requestedChange}
          requestedFile={requestedFile}
          onWidthChange={(width, persist) => {
            const next = {
              ...prefsRef.current,
              values: { ...prefsRef.current.values, detailsWidth: width },
            };
            prefsRef.current = next;
            setPrefs(next);
            if (persist) void patchPreferences({ detailsWidth: width });
          }}
        />
      )}{" "}
    </>
  );
}
