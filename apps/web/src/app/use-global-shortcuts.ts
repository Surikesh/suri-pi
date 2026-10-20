import { useEffect, useLayoutEffect } from "react";
import type { Data } from "../../../../packages/protocol/src/index.js";
import { command, type State } from "../store.js";
import { viewStorage as localStorage } from "../view-storage.js";
import type { useSessionProjectMenus } from "../features/menus/index.js";
import type { createNewSessionController } from "../features/dialogs/index.js";
import type { DialogState, ShellState } from "./use-app-state.js";
import type { SessionView } from "./use-session-view.js";

export function useModalFocusTrap({
  dialogs,
  attachmentPreview,
  newSessionDialog,
  projection,
}: {
  dialogs: DialogState;
  attachmentPreview: Data | undefined;
  newSessionDialog: unknown;
  projection: SessionView["projection"];
}) {
  const { settings, scopePanel, utilityPanel } = dialogs;
  useEffect(() => {
    const modal = document.querySelectorAll<HTMLElement>('[role="dialog"]');
    const dialog = modal[modal.length - 1];
    if (!dialog) return;
    const prior = document.activeElement as HTMLElement | null;
    const focusable = () =>
      Array.from(
        dialog.querySelectorAll<HTMLElement>(
          'button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),a[href],[tabindex="0"]',
        ),
      );
    focusable()[0]?.focus();
    const key = (e: KeyboardEvent) => {
      if (e.key === "Tab") {
        const items = focusable();
        if (!items.length) return;
        e.preventDefault();
        const index = items.indexOf(document.activeElement as HTMLElement);
        items[
          (index + (e.shiftKey ? -1 : 1) + items.length) % items.length
        ].focus();
      }
    };
    dialog.addEventListener("keydown", key);
    return () => {
      dialog.removeEventListener("keydown", key);
      prior?.focus();
    };
  }, [
    settings,
    scopePanel,
    utilityPanel,
    attachmentPreview,
    newSessionDialog,
    Object.keys(projection.interactions).join(","),
  ]);
}

export function useGlobalShortcuts({
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
}: {
  state: State;
  session: SessionView["session"];
  projection: SessionView["projection"];
  shell: ShellState;
  dialogs: DialogState;
  menus: ReturnType<typeof useSessionProjectMenus>;
  attachmentPreview: Data | undefined;
  closeAttachmentPreview: () => void;
  newSessionDialog: unknown;
  openNewSessionDialog: ReturnType<
    typeof createNewSessionController
  >["openNewSessionDialog"];
  closeNewSessionDialog: () => void;
  prefsRef: { current: Data };
  patchPreferences: (patch: Data) => Promise<unknown>;
  act: (fn: () => Promise<unknown>) => Promise<void>;
}) {
  const {
    setCommandHeld,
    setSidebar,
    setSidebarCollapsed,
    search,
    endNavigationDrag,
    viewOptions,
    setViewOptions,
    viewOptionsTrigger,
    setDetails,
    editor,
  } = shell;
  const {
    linkedFile,
    setLinkedFile,
    setSettings,
    setScopePanel,
    setUtilityPanel,
  } = dialogs;
  const { sessionMenu, projectMenu, closeSessionMenu, closeProjectMenu } =
    menus;
  useEffect(() => {
    const releaseCommandHints = () => setCommandHeld(false);
    const keyUp = (e: KeyboardEvent) => {
      if (e.key === "Meta") releaseCommandHints();
    };
    const key = (e: KeyboardEvent) => {
      setCommandHeld(e.key === "Meta" || e.metaKey);
      if (e.metaKey && e.key === "k") {
        e.preventDefault();
        setSidebar(true);
        setSidebarCollapsed(false);
        localStorage.setItem("suri.sidebarCollapsed", "false");
        requestAnimationFrame(() => search.current?.focus());
      }
      if (
        e.ctrlKey &&
        e.altKey &&
        !e.metaKey &&
        !e.shiftKey &&
        e.code === "KeyN" &&
        !e.repeat &&
        !e.isComposing &&
        state.catalog.workspaces.length > 0
      ) {
        e.preventDefault();
        openNewSessionDialog();
      }
      if (
        e.ctrlKey &&
        e.altKey &&
        !e.metaKey &&
        !e.shiftKey &&
        e.code === "KeyL" &&
        !e.repeat &&
        !e.isComposing
      ) {
        e.preventDefault();
        const nextGroup =
          prefsRef.current.values.navigationGroup === "list"
            ? "workspace"
            : "list";
        void patchPreferences({ navigationGroup: nextGroup });
      }
      if (
        e.metaKey &&
        !e.ctrlKey &&
        !e.altKey &&
        !e.shiftKey &&
        /^Digit[1-9]$/.test(e.code) &&
        !e.repeat &&
        !e.isComposing
      ) {
        const index = Number(e.code.slice(-1)) - 1;
        const rows = Array.from(
          document.querySelectorAll<HTMLButtonElement>(
            ".sidebar nav .session-row",
          ),
        ).filter((row) => row.offsetParent !== null);
        const row = rows[index];
        if (row) {
          e.preventDefault();
          row.click();
        }
      }
      if (e.key === "Escape") {
        if (attachmentPreview) {
          e.preventDefault();
          closeAttachmentPreview();
          return;
        }
        if (linkedFile) {
          e.preventDefault();
          setLinkedFile(undefined);
          return;
        }
        if (
          e.defaultPrevented ||
          (e.target instanceof Element &&
            e.target.closest(".workspace-details"))
        )
          return;
        endNavigationDrag();
        if (newSessionDialog) {
          e.preventDefault();
          closeNewSessionDialog();
          return;
        }
        if (viewOptions) {
          e.preventDefault();
          setViewOptions(false);
          viewOptionsTrigger.current?.focus();
          return;
        }
        if (sessionMenu) {
          e.preventDefault();
          closeSessionMenu();
          return;
        }
        if (projectMenu) {
          e.preventDefault();
          closeProjectMenu();
          return;
        }
        const interaction = Object.values(projection.interactions)[0];
        if (interaction && session)
          void act(() =>
            command(
              "interaction.respond",
              {
                interactionId: interaction.interactionId,
                answer: { cancelled: true },
              },
              session.id,
            ),
          );
        setSettings(false);
        setScopePanel(false);
        setUtilityPanel(undefined);
        setSidebar(false);
        setDetails(false);
        editor.current?.focus();
      }
    };
    window.addEventListener("keydown", key);
    window.addEventListener("keyup", keyUp);
    window.addEventListener("blur", releaseCommandHints);
    return () => {
      window.removeEventListener("keydown", key);
      window.removeEventListener("keyup", keyUp);
      window.removeEventListener("blur", releaseCommandHints);
    };
  });
  useLayoutEffect(() => {
    let visibleIndex = 0;
    for (const item of document.querySelectorAll<HTMLElement>(
      ".sidebar nav .session-item",
    )) {
      const row = item.querySelector<HTMLElement>(".session-row");
      if (row?.offsetParent === null) {
        item.dataset.shortcut = "";
        continue;
      }
      visibleIndex += 1;
      item.dataset.shortcut = visibleIndex <= 9 ? String(visibleIndex) : "";
    }
  });
}
