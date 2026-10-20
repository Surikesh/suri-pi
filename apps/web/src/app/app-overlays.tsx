import type { Data } from "../../../../packages/protocol/src/index.js";
import { LinkedFilePreview } from "../file-preview.js";
import { CatalogDialog } from "../catalog.js";
import { DirectoryDialog } from "../directory-picker.js";
import { command, report, type State } from "../store.js";
import { compactSessionAge } from "../domain/presentation.js";
import { Dialog } from "../features/transcript/index.js";
import {
  FileMenu,
  MenuScrim,
  ProjectMenu,
  SessionMenu,
  type useFileMenu,
  type useSessionProjectMenus,
} from "../features/menus/index.js";
import {
  AttachmentLightbox,
  ScopeDialog,
  SettingsDialog,
  UtilityDialog,
} from "../features/dialogs/index.js";
import type { DialogState, ShellState } from "./use-app-state.js";
import type { PreferencesState } from "./use-preferences.js";
import type { SessionView } from "./use-session-view.js";
import type { useModelDiscovery } from "./use-model-catalog.js";
import type { useFileActions } from "./use-file-actions.js";

export function AppOverlays({
  state,
  view,
  shell,
  dialogs,
  menus,
  fileMenuState,
  files,
  attachmentPreview,
  closeAttachmentPreview,
  models,
  loadModels,
  prefsState,
  act,
  create,
}: {
  state: State;
  view: SessionView;
  shell: ShellState;
  dialogs: DialogState;
  menus: ReturnType<typeof useSessionProjectMenus>;
  fileMenuState: ReturnType<typeof useFileMenu>;
  files: ReturnType<typeof useFileActions>;
  attachmentPreview: Data | undefined;
  closeAttachmentPreview: () => void;
  models: Data[];
  loadModels: ReturnType<typeof useModelDiscovery>["loadModels"];
  prefsState: PreferencesState;
  act: (fn: () => Promise<unknown>) => Promise<void>;
  create: (workspaceId?: string) => Promise<void>;
}) {
  const { session, workspace, projection, running } = view;
  const {
    setFilter,
    setDetails,
    viewOptionsTrigger,
    setViewOptions,
    sessionTooltip,
  } = shell;
  const {
    settings,
    setSettings,
    utilityPanel,
    setUtilityPanel,
    scopePanel,
    setScopePanel,
    scopeToken,
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
    historyInput,
    iconInput,
    importPreview,
    setImportPreview,
    importing,
    setImporting,
    setIconTarget,
    tree,
    setTree,
    treeSessionId,
    setTreeSessionId,
    worktrees,
    setWorktrees,
    linkedFile,
    setLinkedFile,
    setRequestedFile,
    directoryDialog,
    setDirectoryDialog,
    catalogDialog,
    setCatalogDialog,
  } = dialogs;
  const {
    sessionMenu,
    sessionMenuName,
    setSessionMenuName,
    sessionMenuRenaming,
    setSessionMenuRenaming,
    projectMenu,
    confirmProjectRemoval,
    setConfirmProjectRemoval,
    closeSessionMenu,
    closeProjectMenu,
  } = menus;
  const { fileMenu, fileMenuStatus, closeFileMenu } = fileMenuState;
  const { fileMenuWorkspace, pinChange, fileAction } = files;
  const { prefs, patchPreferences } = prefsState;
  const revealPath = (path: string) => {
    if (!window.webkit) {
      report(Error("Reveal in Finder is available in the Suri Pi app."));
      return;
    }
    window.webkit.messageHandlers.suri.postMessage({
      type: "revealPath",
      path,
    });
  };
  return (
    <>
      <AttachmentLightbox
        attachmentPreview={attachmentPreview}
        closeAttachmentPreview={closeAttachmentPreview}
      />
      <ScopeDialog
        scopePanel={scopePanel}
        setScopePanel={setScopePanel}
        scopeToken={scopeToken}
        scopeDraft={scopeDraft}
        setScopeDraft={setScopeDraft}
        scopeSearch={scopeSearch}
        setScopeSearch={setScopeSearch}
        scopePhase={scopePhase}
        setScopePhase={setScopePhase}
        scopeError={scopeError}
        setScopeError={setScopeError}
        scopeOffset={scopeOffset}
        setScopeOffset={setScopeOffset}
        session={session}
        models={models}
        loadModels={loadModels}
        patchPreferences={patchPreferences}
      />
      <UtilityDialog
        utilityPanel={utilityPanel}
        setUtilityPanel={setUtilityPanel}
      />
      <SettingsDialog
        settings={settings}
        setSettings={setSettings}
        state={state}
        prefs={prefs}
        session={session}
        workspace={workspace}
        running={running}
        act={act}
        create={create}
        historyInput={historyInput}
        iconInput={iconInput}
        importPreview={importPreview}
        setImportPreview={setImportPreview}
        importing={importing}
        setImporting={setImporting}
        setIconTarget={setIconTarget}
        tree={tree}
        setTree={setTree}
        treeSessionId={treeSessionId}
        setTreeSessionId={setTreeSessionId}
        worktrees={worktrees}
        setWorktrees={setWorktrees}
        patchPreferences={patchPreferences}
      />
      {Object.values(projection.interactions)
        .slice(0, 1)
        .map((item) => (
          <Dialog key={item.interactionId} item={item} sessionId={session.id} />
        ))}
      <MenuScrim
        sessionMenu={sessionMenu}
        projectMenu={projectMenu}
        fileMenu={fileMenu}
        closeSessionMenu={closeSessionMenu}
        closeProjectMenu={closeProjectMenu}
        closeFileMenu={closeFileMenu}
        setViewOptions={setViewOptions}
        viewOptionsTrigger={viewOptionsTrigger}
      />
      <FileMenu
        fileMenu={fileMenu}
        fileMenuStatus={fileMenuStatus}
        fileMenuWorkspace={fileMenuWorkspace}
        closeFileMenu={closeFileMenu}
        setLinkedFile={setLinkedFile}
        pinChange={pinChange}
        setDetails={setDetails}
        setRequestedFile={setRequestedFile}
        fileAction={fileAction}
      />
      <SessionMenu
        sessionMenu={sessionMenu}
        sessionMenuName={sessionMenuName}
        setSessionMenuName={setSessionMenuName}
        sessionMenuRenaming={sessionMenuRenaming}
        setSessionMenuRenaming={setSessionMenuRenaming}
        closeSessionMenu={closeSessionMenu}
        state={state}
        act={act}
        revealPath={revealPath}
        setSettings={setSettings}
        setTreeSessionId={setTreeSessionId}
        setTree={setTree}
      />
      {sessionTooltip &&
        (() => {
          const previewSession = state.catalog.sessions.find(
            (candidate: Data) => candidate.id === sessionTooltip.sessionId,
          );
          if (!previewSession) return null;
          const updatedAt =
            previewSession.updatedAt ?? previewSession.createdAt;
          const age = compactSessionAge(updatedAt);
          return (
            <aside
              id="session-history-preview"
              className="session-history-preview"
              role="tooltip"
              style={{ left: sessionTooltip.x, top: sessionTooltip.y }}
            >
              <div className="session-history-heading">
                <strong>{previewSession.name}</strong>
                {age && (
                  <time
                    dateTime={updatedAt}
                    title={new Date(updatedAt).toLocaleString()}
                  >
                    {age}
                  </time>
                )}
              </div>
              <div className="session-history-excerpt" aria-live="polite">
                {sessionTooltip.loaded ? (
                  sessionTooltip.excerpt ? (
                    <>
                      <span className="session-history-speaker">
                        {sessionTooltip.speaker}
                      </span>
                      <p>{sessionTooltip.excerpt}</p>
                    </>
                  ) : (
                    <p className="session-history-empty">No conversation yet</p>
                  )
                ) : (
                  <p className="session-history-empty">
                    Loading latest message…
                  </p>
                )}
              </div>
            </aside>
          );
        })()}
      {linkedFile && (
        <LinkedFilePreview
          workspaceId={linkedFile.workspaceId}
          path={linkedFile.path}
          line={linkedFile.line}
          close={() => setLinkedFile(undefined)}
        />
      )}
      {directoryDialog !== undefined && (
        <DirectoryDialog
          project={directoryDialog ?? undefined}
          close={() => setDirectoryDialog(undefined)}
          added={(result) => {
            if (directoryDialog) return;
            setFilter("");
            void act(async () => {
              await patchPreferences({
                navigationGroup: "projects",
                generalCollapsed: false,
              });
              const catalog = await command("catalog.get");
              const addedWorkspace = catalog.workspaces.find(
                (w: Data) => w.projectId === result.id,
              );
              if (addedWorkspace && state.catalog.runtimes.length > 0)
                await create(addedWorkspace.id);
            });
          }}
        />
      )}
      {catalogDialog !== undefined && (
        <CatalogDialog
          catalog={state.catalog}
          sectionsOnly={catalogDialog === null}
          project={catalogDialog ?? undefined}
          close={() => setCatalogDialog(undefined)}
        />
      )}
      <ProjectMenu
        projectMenu={projectMenu}
        confirmProjectRemoval={confirmProjectRemoval}
        setConfirmProjectRemoval={setConfirmProjectRemoval}
        closeProjectMenu={closeProjectMenu}
        state={state}
        act={act}
        revealPath={revealPath}
        setCatalogDialog={setCatalogDialog}
        setDirectoryDialog={setDirectoryDialog}
        setIconTarget={setIconTarget}
        iconInput={iconInput}
      />
    </>
  );
}
