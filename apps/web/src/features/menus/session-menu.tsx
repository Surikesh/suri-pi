import React from "react";
import {
  activePhases,
  type Data,
} from "../../../../../packages/protocol/src/index.js";
import { command, dismiss, report, select, type State } from "../../store.js";
import { ActionError, Icon } from "../../components/ui.js";
import { type useSessionProjectMenus } from "./use-menus.js";

type Menus = ReturnType<typeof useSessionProjectMenus>;

export function SessionMenu({
  sessionMenu,
  sessionMenuName,
  setSessionMenuName,
  sessionMenuRenaming,
  setSessionMenuRenaming,
  closeSessionMenu,
  state,
  act,
  revealPath,
  setSettings,
  setTreeSessionId,
  setTree,
}: {
  sessionMenu: Menus["sessionMenu"];
  sessionMenuName: string;
  setSessionMenuName: Menus["setSessionMenuName"];
  sessionMenuRenaming: boolean;
  setSessionMenuRenaming: Menus["setSessionMenuRenaming"];
  closeSessionMenu: () => void;
  state: State;
  act: (fn: () => Promise<unknown>) => Promise<void>;
  revealPath: (path: string) => void;
  setSettings: (value: boolean) => void;
  setTreeSessionId: (value: string) => void;
  setTree: (value: Data[]) => void;
}) {
  return (
    <>
      {sessionMenu && (
        <form
          className="session-menu"
          ref={(node) => {
            if (node)
              node.style.top = `${Math.max(8, Math.min(sessionMenu.y, innerHeight - node.offsetHeight - 8))}px`;
          }}
          role="menu"
          aria-label={`Actions for ${sessionMenu.session.name}`}
          style={{ left: sessionMenu.x, top: sessionMenu.y }}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              closeSessionMenu();
            }
          }}
          onSubmit={(event) => {
            event.preventDefault();
            void act(async () => {
              await command(
                "session.rename",
                { name: sessionMenuName.trim() },
                sessionMenu.session.id,
                sessionMenu.session.revision,
              );
              closeSessionMenu();
            });
          }}
        >
          <ActionError message={state.error} onDismiss={dismiss} />
          <button
            autoFocus
            type="button"
            role="menuitem"
            onClick={() =>
              void act(async () => {
                await command(
                  "session.pin",
                  { pinned: !sessionMenu.session.pinned },
                  sessionMenu.session.id,
                  sessionMenu.session.revision,
                );
                closeSessionMenu();
              })
            }
          >
            <Icon name="pin" />
            {sessionMenu.session.pinned ? "Unpin" : "Pin"}
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() =>
              void act(async () => {
                await command("session.markUnread", {}, sessionMenu.session.id);
                closeSessionMenu();
              })
            }
          >
            <span className="menu-dot" />
            Mark as unread
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() =>
              void act(async () => {
                await command(
                  "session.highlight",
                  { highlighted: !sessionMenu.session.highlighted },
                  sessionMenu.session.id,
                  sessionMenu.session.revision,
                );
                closeSessionMenu();
              })
            }
          >
            <Icon name="highlight" />
            {sessionMenu.session.highlighted ? "Remove highlight" : "Highlight"}
          </button>
          <div className="menu-separator" />
          <button
            type="button"
            role="menuitem"
            disabled={!window.webkit}
            onClick={() => {
              const targetWorkspace = state.catalog.workspaces.find(
                (item: Data) => item.id === sessionMenu.session.workspaceId,
              );
              if (targetWorkspace) revealPath(targetWorkspace.root);
              closeSessionMenu();
            }}
          >
            <Icon name="finder" />
            <span>Reveal in Finder</span>
            {!window.webkit && <small>macOS only</small>}
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              const targetWorkspace = state.catalog.workspaces.find(
                (item: Data) => item.id === sessionMenu.session.workspaceId,
              );
              if (targetWorkspace)
                void act(async () => {
                  await navigator.clipboard.writeText(targetWorkspace.root);
                  closeSessionMenu();
                });
            }}
          >
            <Icon name="copy" />
            Copy project path
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              void act(async () => {
                await navigator.clipboard.writeText(sessionMenu.session.id);
                closeSessionMenu();
              });
            }}
          >
            <Icon name="copy" />
            Copy session ID
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              void act(async () => {
                await navigator.clipboard.writeText(
                  window.webkit
                    ? `suri-pi://session/${sessionMenu.session.id}`
                    : `${location.origin}${location.pathname}?session=${encodeURIComponent(sessionMenu.session.id)}`,
                );
                closeSessionMenu();
              });
            }}
          >
            <Icon name="copy" />
            Copy session link
          </button>
          <div className="menu-separator" />
          {sessionMenuRenaming ? (
            <label>
              Session name
              <input
                autoFocus
                value={sessionMenuName}
                onChange={(e) => setSessionMenuName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    e.currentTarget.form?.requestSubmit();
                  }
                }}
              />
              <button
                role="menuitem"
                disabled={!sessionMenuName.trim()}
                type="submit"
              >
                Save name
              </button>
            </label>
          ) : (
            <button
              type="button"
              role="menuitem"
              onClick={() => setSessionMenuRenaming(true)}
            >
              Rename
            </button>
          )}
          <button
            type="button"
            role="menuitem"
            disabled={activePhases.has(sessionMenu.session.phase)}
            onClick={() => {
              const target = sessionMenu.session;
              closeSessionMenu();
              setSettings(true);
              setTreeSessionId(target.id);
              void command("session.tree", {}, target.id)
                .then((result) => setTree(result.entries ?? []))
                .catch(report);
            }}
          >
            <Icon name="branch" />
            Fork session
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={activePhases.has(sessionMenu.session.phase)}
            onClick={() =>
              void act(async () => {
                const result = await command(
                  "session.clone",
                  {},
                  sessionMenu.session.id,
                  sessionMenu.session.revision,
                );
                if (result.id) select(result.id);
                closeSessionMenu();
              })
            }
          >
            Clone session
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={
              activePhases.has(sessionMenu.session.phase) ||
              sessionMenu.session.phase === "closed"
            }
            onClick={() =>
              void act(async () => {
                await command(
                  "session.close",
                  {},
                  sessionMenu.session.id,
                  sessionMenu.session.revision,
                );
                closeSessionMenu();
              })
            }
          >
            Close session
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={activePhases.has(sessionMenu.session.phase)}
            onClick={() =>
              void act(async () => {
                await command(
                  "session.archive",
                  { archived: !sessionMenu.session.archived },
                  sessionMenu.session.id,
                  sessionMenu.session.revision,
                );
                closeSessionMenu();
              })
            }
          >
            <Icon name="archive" />
            {sessionMenu.session.archived ? "Unarchive" : "Archive"}
          </button>
        </form>
      )}
    </>
  );
}
