import React from "react";
import { type Data } from "../../../../../packages/protocol/src/index.js";
import { command, dismiss, type State } from "../../store.js";
import { ActionError, Icon } from "../../components/ui.js";
import { type useSessionProjectMenus } from "./use-menus.js";

type Menus = ReturnType<typeof useSessionProjectMenus>;

export function ProjectMenu({
  projectMenu,
  confirmProjectRemoval,
  setConfirmProjectRemoval,
  closeProjectMenu,
  state,
  act,
  revealPath,
  setCatalogDialog,
  setDirectoryDialog,
  setIconTarget,
  iconInput,
}: {
  projectMenu: Menus["projectMenu"];
  confirmProjectRemoval: boolean;
  setConfirmProjectRemoval: (value: boolean) => void;
  closeProjectMenu: () => void;
  state: State;
  act: (fn: () => Promise<unknown>) => Promise<void>;
  revealPath: (path: string) => void;
  setCatalogDialog: (value: Data) => void;
  setDirectoryDialog: (value: Data) => void;
  setIconTarget: (value: Data) => void;
  iconInput: React.RefObject<HTMLInputElement | null>;
}) {
  return (
    <>
      {projectMenu && (
        <div
          className="session-menu project-menu"
          ref={(node) => {
            if (node)
              node.style.top = `${Math.max(8, Math.min(projectMenu.y, innerHeight - node.offsetHeight - 8))}px`;
          }}
          role="menu"
          aria-label={`Actions for project ${projectMenu.project.label}`}
          style={{ left: projectMenu.x, top: projectMenu.y }}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              closeProjectMenu();
            }
          }}
        >
          <ActionError message={state.error} onDismiss={dismiss} />
          <button
            autoFocus
            role="menuitem"
            onClick={() => {
              setCatalogDialog(projectMenu.project);
              closeProjectMenu();
            }}
          >
            Rename project / workspaces…
          </button>
          <button
            role="menuitem"
            onClick={() => {
              setDirectoryDialog(projectMenu.project);
              closeProjectMenu();
            }}
          >
            Add workspace…
          </button>
          <button
            role="menuitem"
            onClick={() => {
              setIconTarget(projectMenu.project);
              iconInput.current?.click();
              closeProjectMenu();
            }}
          >
            Change icon…
          </button>
          <button
            role="menuitem"
            onClick={() =>
              void act(async () => {
                await command(
                  "project.update",
                  {
                    projectId: projectMenu.project.id,
                    sectionId:
                      projectMenu.project.sectionId === "pinned"
                        ? ""
                        : "pinned",
                  },
                  undefined,
                  projectMenu.project.revision,
                );
                closeProjectMenu();
              })
            }
          >
            {projectMenu.project.sectionId === "pinned"
              ? "Unpin project"
              : "Pin project"}
          </button>
          <button
            role="menuitem"
            disabled={!projectMenu.project.iconId}
            onClick={() =>
              void act(async () => {
                await command(
                  "icon.clear",
                  { targetId: projectMenu.project.id },
                  undefined,
                  projectMenu.project.revision,
                );
                closeProjectMenu();
              })
            }
          >
            Remove manual icon
          </button>
          <button
            role="menuitem"
            disabled={!window.webkit}
            onClick={() => {
              revealPath(projectMenu.project.root);
              closeProjectMenu();
            }}
          >
            <Icon name="finder" />
            <span>Reveal in Finder</span>
            {!window.webkit && <small>macOS only</small>}
          </button>
          <button
            role="menuitem"
            onClick={() => {
              void act(async () => {
                await navigator.clipboard.writeText(projectMenu.project.root);
                closeProjectMenu();
              });
            }}
          >
            <Icon name="copy" />
            Copy project path
          </button>
          <div className="menu-separator" />
          {confirmProjectRemoval ? (
            <>
              <p className="menu-confirm">
                Remove from Suri only? The folder and histories stay untouched.
              </p>
              <button
                className="danger"
                role="menuitem"
                onClick={() =>
                  void act(async () => {
                    await command(
                      "project.forget",
                      { projectId: projectMenu.project.id },
                      undefined,
                      projectMenu.project.revision,
                    );
                    closeProjectMenu();
                  })
                }
              >
                Confirm remove
              </button>
            </>
          ) : (
            <button
              className="danger"
              role="menuitem"
              onClick={() => setConfirmProjectRemoval(true)}
            >
              <Icon name="remove" />
              Remove from Suri…
            </button>
          )}
        </div>
      )}
    </>
  );
}
