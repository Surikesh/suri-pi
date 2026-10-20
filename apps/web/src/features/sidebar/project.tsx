import type { Data } from "../../../../../packages/protocol/src/index.js";
import { Icon } from "../../components/ui.js";
import { FolderIcon } from "../../icons.js";
import type { SidebarProps } from "./types.js";
import { sessionRowRenderer } from "./session-row.js";

export function renderProject(props: SidebarProps, section: Data, p: Data) {
  const renderSessionRow = sessionRowRenderer(props);
  const {
    state,
    filter,
    act,
    create,
    openProjectMenu,
    setIconTarget,
    iconInput,
    startNavigationDrag,
    endNavigationDrag,
    dragSource,
    setDropMarker,
  } = props;
  const {
    orderedProjects,
    projectCollapsed,
    projectSessionsExpanded,
    patchProjectPreference,
    sessionsForProject,
    displayedProjectSessionIds,
    manualNavigation,
    edgeAt,
    dropClass,
    projectDrop,
    orderSessions,
    sessionVisible,
  } = props.navigation;
  return (
    <div
      className={`project${dropClass(`project:${p.id}`)}`}
      key={p.id}
      onDragOver={(event) => {
        if (!manualNavigation || !dragSource.current.startsWith("project:"))
          return;
        event.preventDefault();
        event.stopPropagation();
        event.dataTransfer.dropEffect = "move";
        const row =
          event.currentTarget.querySelector<HTMLElement>(".project-row")!;
        setDropMarker({
          key: `project:${p.id}`,
          edge: edgeAt(event, row),
        });
      }}
      onDrop={(event) => {
        if (!manualNavigation || !dragSource.current.startsWith("project:"))
          return;
        event.preventDefault();
        event.stopPropagation();
        const row =
          event.currentTarget.querySelector<HTMLElement>(".project-row")!;
        void projectDrop(
          dragSource.current,
          section,
          p,
          edgeAt(event, row) === "after",
        );
        endNavigationDrag();
      }}
    >
      <div
        className="project-row"
        draggable={manualNavigation}
        tabIndex={0}
        aria-label={`Project ${p.label}, ${projectCollapsed(p) ? "collapsed" : "expanded"}`}
        data-expanded={!projectCollapsed(p)}
        title={
          manualNavigation
            ? "Drag to reorder · Alt+Shift+↑/↓"
            : "Switch to Manual in View options to reorder"
        }
        onDragStart={(event) =>
          startNavigationDrag(event, `project:${p.id}`, event.currentTarget)
        }
        onDragEnd={endNavigationDrag}
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget) return;
          if (
            !event.altKey &&
            !event.shiftKey &&
            (event.key === "Enter" || event.key === " ")
          ) {
            event.preventDefault();
            void patchProjectPreference(
              "projectCollapsed",
              p.id,
              !projectCollapsed(p),
            );
            return;
          }
          if (
            !manualNavigation ||
            !event.altKey ||
            !event.shiftKey ||
            !["ArrowUp", "ArrowDown"].includes(event.key)
          )
            return;
          event.preventDefault();
          const siblings = orderedProjects.filter(
            (item: Data) => (item.sectionId ?? "") === section.id,
          );
          const target =
            siblings[
              siblings.findIndex((item: Data) => item.id === p.id) +
                (event.key === "ArrowDown" ? 1 : -1)
            ];
          if (target)
            void projectDrop(
              `project:${p.id}`,
              section,
              target,
              event.key === "ArrowDown",
            );
        }}
        onContextMenu={(event) => {
          event.preventDefault();
          openProjectMenu(
            p,
            event.currentTarget.querySelector<HTMLElement>(
              ".project-menu-button",
            ) ?? event.currentTarget,
            event.clientX,
            event.clientY,
          );
        }}
        onClick={() =>
          void patchProjectPreference(
            "projectCollapsed",
            p.id,
            !projectCollapsed(p),
          )
        }
      >
        <button
          className="project-icon"
          aria-label={`Set icon for ${p.label}`}
          onClick={(event) => {
            event.stopPropagation();
            setIconTarget(p);
            iconInput.current?.click();
          }}
        >
          {p.iconId || p.autoIconId ? (
            <img src={"/v1/assets/" + (p.iconId || p.autoIconId)} alt="" />
          ) : (
            <FolderIcon />
          )}
        </button>
        <span className="project-label">{p.label}</span>
        <button
          className="project-menu-button"
          aria-label={`Actions for project ${p.label}`}
          onClick={(event) => {
            event.stopPropagation();
            const rect = event.currentTarget.getBoundingClientRect();
            openProjectMenu(p, event.currentTarget, rect.right, rect.bottom);
          }}
        >
          <Icon name="dots" />
        </button>
        <button
          className="project-new-session"
          aria-label={`New session in ${p.label}`}
          title="New session"
          onClick={(event) => {
            event.stopPropagation();
            void act(() =>
              create(
                state.catalog.workspaces.find((w: Data) => w.projectId === p.id)
                  ?.id,
              ),
            );
          }}
        >
          <Icon name="newSession" />
        </button>
      </div>
      {(!projectCollapsed(p) || filter) &&
        state.catalog.workspaces
          .filter((candidate: Data) => candidate.projectId === p.id)
          .map((workspaceGroup: Data) => (
            <div
              className="workspace-group"
              key={workspaceGroup.id}
              role="group"
              aria-label={
                workspaceGroup.label ?? workspaceGroup.branch ?? "Workspace"
              }
            >
              {(state.catalog.workspaces.filter(
                (candidate: Data) => candidate.projectId === p.id,
              ).length > 1 ||
                (workspaceGroup.label ??
                  workspaceGroup.branch ??
                  workspaceGroup.root.split("/").pop()) !== p.label) && (
                <button
                  className="workspace-label"
                  title={workspaceGroup.root}
                  aria-label={`New session in workspace ${workspaceGroup.label}`}
                  onClick={() => void act(() => create(workspaceGroup.id))}
                >
                  {workspaceGroup.label ??
                    workspaceGroup.branch ??
                    workspaceGroup.root.split("/").pop() ??
                    "Workspace"}
                </button>
              )}
              {orderSessions(state.catalog.sessions)
                .filter(
                  (candidate: Data) =>
                    !candidate.pinned &&
                    candidate.workspaceId === workspaceGroup.id &&
                    sessionVisible(candidate, p) &&
                    displayedProjectSessionIds(p).has(candidate.id),
                )
                .map((candidate: Data) => renderSessionRow(candidate))}
            </div>
          ))}
      {(!projectCollapsed(p) || filter) &&
        !filter &&
        sessionsForProject(p).length > 5 && (
          <button
            className="project-session-toggle"
            onClick={() =>
              void patchProjectPreference(
                "projectSessionsExpanded",
                p.id,
                !projectSessionsExpanded(p),
              )
            }
          >
            {projectSessionsExpanded(p) ? "Show less" : "Show more"}
          </button>
        )}
    </div>
  );
}
