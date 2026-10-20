import type { Dispatch, SetStateAction } from "react";
import { Icon } from "../../components/ui.js";
import type { Direction, WorkspaceLayout } from "./layout.js";

export function TerminalBar({
  layout,
  setLayout,
  renameGroupId,
  setRenameGroupId,
  totalPanes,
  newGroup,
  splitActive,
  closePane,
}: {
  layout: WorkspaceLayout;
  setLayout: Dispatch<SetStateAction<WorkspaceLayout>>;
  renameGroupId: string | undefined;
  setRenameGroupId: Dispatch<SetStateAction<string | undefined>>;
  totalPanes: number;
  newGroup: () => void;
  splitActive: (direction: Direction) => void;
  closePane: (groupId: string, paneId: string) => void;
}) {
  return (
    <div className="terminal-workspace-bar">
      <div className="terminal-tabs" role="tablist" aria-label="Terminals">
        {layout.groups.map((group) => (
          <div className="terminal-tab-wrap" key={group.id}>
            {renameGroupId === group.id ? (
              <input
                className="terminal-tab-rename"
                aria-label="Terminal name"
                defaultValue={group.title}
                autoFocus
                onBlur={(event) => {
                  const title = event.currentTarget.value.trim();
                  if (title)
                    setLayout((current) => ({
                      ...current,
                      groups: current.groups.map((candidate) =>
                        candidate.id === group.id
                          ? { ...candidate, title }
                          : candidate,
                      ),
                    }));
                  setRenameGroupId(undefined);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") event.currentTarget.blur();
                  if (event.key === "Escape") setRenameGroupId(undefined);
                }}
              />
            ) : (
              <button
                className="terminal-tab-select"
                role="tab"
                aria-selected={group.id === layout.activeGroupId}
                title="Double-click to rename"
                onClick={() =>
                  setLayout((current) => ({
                    ...current,
                    activeGroupId: group.id,
                  }))
                }
                onDoubleClick={() => setRenameGroupId(group.id)}
              >
                {group.title}
              </button>
            )}
            {renameGroupId !== group.id && (
              <span className="terminal-tab-actions">
                <button
                  aria-label={`Restart ${group.title}`}
                  title="Restart terminal"
                  onClick={() =>
                    window.dispatchEvent(
                      new CustomEvent("suri-restart-terminal", {
                        detail: { paneId: group.activePaneId },
                      }),
                    )
                  }
                >
                  <Icon variant="terminal" name="restart" />
                </button>
                <button
                  aria-label={`Close ${group.title}`}
                  title="Close terminal"
                  onClick={() => closePane(group.id, group.activePaneId)}
                >
                  <Icon variant="terminal" name="close" />
                </button>
              </span>
            )}
          </div>
        ))}
      </div>
      <div className="terminal-workspace-actions">
        <span className="terminal-limit" aria-live="polite">
          {totalPanes}/4
        </span>
        <button
          aria-label="New terminal"
          title="New terminal (⌘⇧T)"
          disabled={totalPanes >= 4}
          onClick={newGroup}
        >
          <Icon variant="terminal" name="plus" />
        </button>
        <button
          aria-label="Split terminal right"
          title="Split right (⌘⇧D)"
          disabled={totalPanes >= 4}
          onClick={() => splitActive("row")}
        >
          <Icon variant="terminal" name="split-right" />
        </button>
        <button
          aria-label="Split terminal down"
          title="Split down (⌥⌘⇧D)"
          disabled={totalPanes >= 4}
          onClick={() => splitActive("column")}
        >
          <Icon variant="terminal" name="split-down" />
        </button>
      </div>
    </div>
  );
}
