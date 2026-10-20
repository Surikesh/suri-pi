import type React from "react";
import type { Data } from "../../../../packages/protocol/src/index.js";
import {
  command,
  report,
  upload,
  uploadHistory,
  type State,
} from "../store.js";
import { prepareIconUpload } from "../branding.js";
import {
  Sidebar,
  type useSidebarNavigation,
} from "../features/sidebar/index.js";
import type { useSessionProjectMenus } from "../features/menus/index.js";
import type { createNewSessionController } from "../features/dialogs/index.js";
import type { DialogState, ShellState } from "./use-app-state.js";
import type { PreferencesState } from "./use-preferences.js";
import type { SessionView } from "./use-session-view.js";

export function AppLayout({
  state,
  session,
  navigation,
  narrow,
  shell,
  dialogs,
  prefsState,
  menus,
  openNewSessionDialog,
  addFiles,
  act,
  create,
  children,
}: {
  state: State;
  session: SessionView["session"];
  navigation: ReturnType<typeof useSidebarNavigation>;
  narrow: boolean;
  shell: ShellState;
  dialogs: DialogState;
  prefsState: PreferencesState;
  menus: ReturnType<typeof useSessionProjectMenus>;
  openNewSessionDialog: ReturnType<
    typeof createNewSessionController
  >["openNewSessionDialog"];
  addFiles: (files: File[]) => Promise<unknown>;
  act: (fn: () => Promise<unknown>) => Promise<void>;
  create: (workspaceId?: string) => Promise<void>;
  children?: React.ReactNode;
}) {
  const {
    filter,
    setFilter,
    sidebar,
    setSidebar,
    sidebarCollapsed,
    setSidebarCollapsed,
    navigationToggle,
    dragSource,
    setDropMarker,
    endNavigationDrag,
    startNavigationDrag,
    commandHeld,
    viewOptionsTrigger,
    viewOptions,
    setViewOptions,
    sessionTooltip,
    archived,
    setArchived,
    editor,
    search,
  } = shell;
  const {
    setDirectoryDialog,
    setCatalogDialog,
    setIconTarget,
    iconInput,
    iconTarget,
    setSettings,
    historyInput,
  } = dialogs;
  const { prefs, prefsRef, patchPreferences, setSidebarWidth } = prefsState;
  const { openProjectMenu, openSessionMenu } = menus;
  return (
    <div
      className={`shell ${sidebarCollapsed ? "navigation-collapsed" : ""}`}
      onDragOver={(event) => {
        const types = Array.from(event.dataTransfer.types);
        if (!types.includes("Files") && !types.includes("text/uri-list"))
          return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
      }}
      onDrop={(event) => {
        const files = Array.from(event.dataTransfer.files);
        if (files.length > 0) {
          event.preventDefault();
          event.stopPropagation();
          void addFiles(files)
            .then(() => editor.current?.focus())
            .catch(report);
          return;
        }
        const uri = event.dataTransfer.getData("text/uri-list").trim();
        if (uri.startsWith("file://")) {
          event.preventDefault();
          event.stopPropagation();
          report(
            Error(
              "The browser received a file link without its contents. Drag the Raycast file result itself, not its path or preview link.",
            ),
          );
        }
      }}
      onDragEnd={endNavigationDrag}
    >
      <Sidebar
        state={state}
        navigation={navigation}
        sidebar={sidebar}
        setSidebar={setSidebar}
        sidebarCollapsed={sidebarCollapsed}
        setSidebarCollapsed={setSidebarCollapsed}
        commandHeld={commandHeld}
        narrow={narrow}
        navigationToggle={navigationToggle}
        openNewSessionDialog={openNewSessionDialog}
        search={search}
        filter={filter}
        setFilter={setFilter}
        viewOptionsTrigger={viewOptionsTrigger}
        viewOptions={viewOptions}
        setViewOptions={setViewOptions}
        setDirectoryDialog={setDirectoryDialog}
        setCatalogDialog={setCatalogDialog}
        prefs={prefs}
        prefsRef={prefsRef}
        patchPreferences={patchPreferences}
        act={act}
        create={create}
        openProjectMenu={openProjectMenu}
        openSessionMenu={openSessionMenu}
        setIconTarget={setIconTarget}
        iconInput={iconInput}
        archived={archived}
        setArchived={setArchived}
        setSettings={setSettings}
        setSidebarWidth={setSidebarWidth}
        startNavigationDrag={startNavigationDrag}
        endNavigationDrag={endNavigationDrag}
        dragSource={dragSource}
        setDropMarker={setDropMarker}
        sessionTooltip={sessionTooltip}
      />
      <input
        hidden
        ref={iconInput}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/svg+xml,.svg"
        onChange={(e) =>
          void act(async () => {
            const file = e.target.files?.[0];
            if (!file || !iconTarget) return;
            const asset = await upload(
              await prepareIconUpload(file),
              session?.id ?? "",
              "icon",
            );
            await command(
              "icon.set",
              { targetId: iconTarget.id, assetId: asset.id },
              undefined,
              (
                state.catalog.projects.find(
                  (p: Data) => p.id === iconTarget.id,
                ) ??
                state.catalog.sessions.find((s: Data) => s.id === iconTarget.id)
              )?.revision,
            );
            e.target.value = "";
          })
        }
      />
      <input
        hidden
        ref={historyInput}
        type="file"
        accept=".jsonl,application/json"
        multiple
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          void act(async () => {
            if (!files.length || files.length > 100)
              throw Error("Choose between 1 and 100 histories.");
            const grants = [];
            for (const file of files) grants.push(await uploadHistory(file));
            await window.suriImportFiles?.(grants);
            e.target.value = "";
          });
        }}
      />
      {children}
    </div>
  );
}
