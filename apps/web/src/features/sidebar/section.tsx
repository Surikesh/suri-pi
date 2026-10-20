import type { Data } from "../../../../../packages/protocol/src/index.js";
import { command } from "../../store.js";
import { Icon } from "../../components/ui.js";
import type { SidebarProps } from "./types.js";
import { sessionRowRenderer } from "./session-row.js";
import { renderProject } from "./project.js";

export function renderSection(props: SidebarProps, section: Data) {
  const renderSessionRow = sessionRowRenderer(props);
  const {
    state,
    filter,
    patchPreferences,
    act,
    startNavigationDrag,
    endNavigationDrag,
    dragSource,
    setDropMarker,
  } = props;
  const {
    orderedProjects,
    allProjectsCollapsed,
    moveNavigation,
    manualNavigation,
    dropClass,
    orderSessions,
    sessionVisible,
    projectForSession,
  } = props.navigation;
  return (
    <div
      key={section.id}
      className={`sidebar-section${dropClass(`section:${section.id}`)}`}
      onDragOver={(e) => {
        if (
          !manualNavigation ||
          !/^(project|section):/.test(dragSource.current)
        )
          return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        setDropMarker({
          key: `section:${section.id}`,
          edge: "after",
        });
      }}
      onDrop={(e) => {
        if (
          !manualNavigation ||
          !/^(project|section):/.test(dragSource.current)
        )
          return;
        e.preventDefault();
        void moveNavigation(dragSource.current, section);
        endNavigationDrag();
      }}
    >
      <div className="section-heading-row">
        <button
          className="section-heading"
          draggable={manualNavigation && !!section.revision}
          onDragStart={(event) =>
            startNavigationDrag(
              event,
              `section:${section.id}`,
              event.currentTarget,
            )
          }
          onDragEnd={endNavigationDrag}
          aria-expanded={!section.collapsed}
          onClick={() =>
            section.revision
              ? void act(() =>
                  command(
                    "section.update",
                    {
                      sectionId: section.id,
                      collapsed: !section.collapsed,
                    },
                    undefined,
                    section.revision,
                  ),
                )
              : void patchPreferences({
                  [`${section.id || "general"}Collapsed`]: !section.collapsed,
                })
          }
        >
          <span className="section-chevron" aria-hidden="true">
            <Icon name={section.collapsed ? "chevronRight" : "chevronDown"} />
          </span>
          <span>{section.label}</span>
        </button>
        {section.id === "" && (
          <button
            className="projects-collapse-all"
            aria-label={allProjectsCollapsed ? "Expand all" : "Collapse all"}
            title={allProjectsCollapsed ? "Expand all" : "Collapse all"}
            onClick={() =>
              void patchPreferences({
                projectCollapsed: Object.fromEntries(
                  orderedProjects.map((project: Data) => [
                    project.id,
                    !allProjectsCollapsed,
                  ]),
                ),
              })
            }
          >
            <Icon name={allProjectsCollapsed ? "expandAll" : "collapseAll"} />
          </button>
        )}
      </div>
      {section.id === "pinned" &&
        (!section.collapsed || filter) &&
        orderSessions(state.catalog.sessions)
          .filter(
            (s: Data) => s.pinned && sessionVisible(s, projectForSession(s)),
          )
          .map((s: Data) => renderSessionRow(s, projectForSession(s)?.label))}
      {(!section.collapsed || filter) &&
        orderedProjects
          .filter((p: Data) => (p.sectionId ?? "") === section.id)
          .filter((project: Data) => {
            const workspaceIds = new Set(
              state.catalog.workspaces
                .filter((item: Data) => item.projectId === project.id)
                .map((item: Data) => item.id),
            );
            return (
              !filter ||
              project.label.toLowerCase().includes(filter.toLowerCase()) ||
              state.catalog.sessions.some(
                (item: Data) =>
                  workspaceIds.has(item.workspaceId) &&
                  sessionVisible(item, project),
              )
            );
          })
          .map((p: Data) => renderProject(props, section, p))}
    </div>
  );
}
