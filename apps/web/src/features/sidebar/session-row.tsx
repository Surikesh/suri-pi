import { activePhases } from "../../../../../packages/protocol/src/index.js";
import type { Data } from "../../../../../packages/protocol/src/index.js";
import { select } from "../../store.js";
import { Icon } from "../../components/ui.js";
import { FolderIcon } from "../../icons.js";
import type { SidebarProps } from "./types.js";

export const sessionRowRenderer = (props: SidebarProps) => {
  const {
    state,
    setSidebar,
    prefs,
    openSessionMenu,
    startNavigationDrag,
    endNavigationDrag,
    dragSource,
    setDropMarker,
    sessionTooltip,
  } = props;
  const {
    manualNavigation,
    sessionSiblings,
    moveSession,
    edgeAt,
    canDropSession,
    dropClass,
    showSessionTooltip,
    hideSessionTooltip,
    projectForSession,
  } = props.navigation;
  return (candidate: Data, projectLabel?: string) => (
    <div
      className={`session-item ${candidate.id === state.selected ? "selected" : ""} ${candidate.highlighted ? "highlighted" : ""}${dropClass(`session:${candidate.id}`)}`}
      onDragOver={(event) => {
        if (!manualNavigation || !canDropSession(candidate)) return;
        event.preventDefault();
        event.stopPropagation();
        event.dataTransfer.dropEffect = "move";
        setDropMarker({ key: `session:${candidate.id}`, edge: edgeAt(event) });
      }}
      onDrop={(event) => {
        if (!manualNavigation || !canDropSession(candidate)) return;
        event.preventDefault();
        event.stopPropagation();
        void moveSession(
          dragSource.current,
          candidate,
          edgeAt(event) === "after",
        );
        endNavigationDrag();
      }}
      key={candidate.id}
      role="group"
      aria-label={candidate.name}
      onContextMenu={(event) => {
        event.preventDefault();
        openSessionMenu(
          candidate,
          event.currentTarget.querySelector(".session-row") as HTMLElement,
          event.clientX,
          event.clientY,
        );
      }}
    >
      <button
        className="session-row"
        draggable={manualNavigation}
        onDragStart={(event) =>
          startNavigationDrag(
            event,
            `session:${candidate.id}`,
            event.currentTarget,
          )
        }
        onDragEnd={endNavigationDrag}
        onKeyDown={(event) => {
          if (
            !manualNavigation ||
            !event.altKey ||
            !event.shiftKey ||
            !["ArrowUp", "ArrowDown"].includes(event.key)
          )
            return;
          event.preventDefault();
          const siblings = sessionSiblings(candidate);
          const target =
            siblings[
              siblings.findIndex((item: Data) => item.id === candidate.id) +
                (event.key === "ArrowDown" ? 1 : -1)
            ];
          if (target)
            void moveSession(
              `session:${candidate.id}`,
              target,
              event.key === "ArrowDown",
            );
        }}
        onPointerEnter={(event) =>
          showSessionTooltip(candidate, event.currentTarget)
        }
        onPointerLeave={hideSessionTooltip}
        onFocus={(event) =>
          showSessionTooltip(candidate, event.currentTarget, 0)
        }
        onBlur={hideSessionTooltip}
        aria-label={candidate.name}
        aria-describedby={
          sessionTooltip?.sessionId === candidate.id
            ? "session-history-preview"
            : undefined
        }
        aria-description={
          activePhases.has(candidate.phase)
            ? "Running"
            : candidate.unread
              ? "Unread"
              : undefined
        }
        onClick={() => {
          select(candidate.id);
          setSidebar(false);
        }}
      >
        {prefs.values.navigationGroup === "list" ? (
          <span className="session-project-icon" aria-hidden="true">
            {(() => {
              const project = projectForSession(candidate);
              const iconId = project?.iconId || project?.autoIconId;
              return iconId ? (
                <img src={`/v1/assets/${iconId}`} alt="" />
              ) : (
                <FolderIcon />
              );
            })()}
          </span>
        ) : candidate.iconId ? (
          <img
            className="session-icon"
            src={`/v1/assets/${candidate.iconId}`}
            alt=""
          />
        ) : !activePhases.has(candidate.phase) && candidate.unread ? (
          <span
            className="status-dot unread"
            aria-hidden="true"
            title="Unread"
          />
        ) : !activePhases.has(candidate.phase) ? (
          <span className="session-leading" />
        ) : null}
        {activePhases.has(candidate.phase) && (
          <span className="session-activity" aria-hidden="true" title="Running">
            <i />
            <i />
            <i />
            <i />
          </span>
        )}
        <span className="session-copy">
          <span>{candidate.name}</span>
          {projectLabel && <small>{projectLabel}</small>}
        </span>
        {candidate.pinned && (
          <span className="session-pin" title="Pinned">
            <Icon name="pin" />
          </span>
        )}
      </button>
      <button
        className="session-menu-button"
        aria-label="More actions"
        onClick={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          openSessionMenu(
            candidate,
            event.currentTarget,
            rect.right,
            rect.bottom,
          );
        }}
      >
        <Icon name="dots" />
      </button>
    </div>
  );
};
