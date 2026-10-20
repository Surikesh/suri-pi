import type { Data } from "../../../../../packages/protocol/src/index.js";
import { viewStorage as localStorage } from "../../view-storage.js";
import { Icon } from "../../components/ui.js";
import { appIcon, appName } from "../../branding.js";
import type { SidebarProps } from "./types.js";
import { sessionRowRenderer } from "./session-row.js";
import { renderViewOptions } from "./view-options.js";
import { renderSection } from "./section.js";

export function Sidebar(props: SidebarProps) {
  const renderSessionRow = sessionRowRenderer(props);
  const {
    state,
    sidebar,
    setSidebar,
    sidebarCollapsed,
    setSidebarCollapsed,
    commandHeld,
    narrow,
    navigationToggle,
    openNewSessionDialog,
    search,
    filter,
    setFilter,
    viewOptionsTrigger,
    viewOptions,
    setViewOptions,
    setDirectoryDialog,
    prefs,
    prefsRef,
    archived,
    setArchived,
    setSettings,
    setSidebarWidth,
  } = props;
  const {
    navigationSections,
    orderSessions,
    sessionVisible,
    projectForSession,
  } = props.navigation;
  return (
    <>
      {sidebar && (
        <button
          className="scrim"
          aria-label="Close navigation"
          onClick={() => setSidebar(false)}
        />
      )}
      <aside
        className={`sidebar ${sidebar ? "open" : ""} ${commandHeld ? "show-session-shortcuts" : ""}`}
        inert={narrow ? !sidebar : sidebarCollapsed}
        aria-label="Projects and sessions"
      >
        <div className="brand">
          <img className="brand-mark" src={appIcon} alt="" />
          <strong>{appName}</strong>
          <button
            className="icon-button"
            aria-label="Close navigation"
            onClick={() => {
              if (narrow) setSidebar(false);
              else {
                setSidebarCollapsed(true);
                localStorage.setItem("suri.sidebarCollapsed", "true");
              }
              requestAnimationFrame(() => navigationToggle.current?.focus());
            }}
          >
            <Icon name="menu" />
          </button>
        </div>
        <button
          className="new-session"
          onClick={(event) => openNewSessionDialog(event.currentTarget)}
        >
          <Icon name="plus" />
          New session <kbd>⌃⌥N</kbd>
        </button>
        <div className="search">
          <Icon name="search" />
          <input
            ref={search}
            aria-label="Filter projects and sessions"
            placeholder="Projects and sessions"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
          <button
            ref={viewOptionsTrigger}
            aria-label="View options"
            aria-expanded={viewOptions}
            onClick={() => setViewOptions((value) => !value)}
          >
            <Icon name="sliders" />
          </button>
          <button
            aria-label="Add project"
            onClick={(event) => {
              event.currentTarget.focus();
              setDirectoryDialog(null);
            }}
          >
            <Icon name="plus" />
          </button>
          {viewOptions && renderViewOptions(props)}
        </div>
        <nav>
          {prefs.values.navigationGroup === "list" ? (
            <div className="flat-sessions">
              {orderSessions(state.catalog.sessions)
                .filter((candidate: Data) =>
                  sessionVisible(candidate, projectForSession(candidate)),
                )
                .map((candidate: Data) =>
                  renderSessionRow(
                    candidate,
                    [
                      projectForSession(candidate)?.label,
                      state.catalog.workspaces.find(
                        (w: Data) => w.id === candidate.workspaceId,
                      )?.label,
                    ]
                      .filter((v, i, a) => v && a.indexOf(v) === i)
                      .join(" / ") || "Unknown project",
                  ),
                )}
            </div>
          ) : (
            navigationSections.map((section: Data) =>
              renderSection(props, section),
            )
          )}
        </nav>
        <footer>
          <button onClick={() => setArchived(!archived)}>
            {archived ? "Show active sessions" : "Archived sessions"}
          </button>
          <button onClick={() => setSettings(true)}>
            <Icon name="settings" />
            Settings
          </button>
        </footer>
      </aside>
      <div
        className="sidebar-resizer"
        role="separator"
        aria-label="Resize sidebar"
        aria-orientation="vertical"
        aria-valuemin={200}
        aria-valuemax={520}
        aria-valuenow={prefs.values.sidebarWidth ?? 232}
        tabIndex={0}
        onPointerDown={(event) => {
          event.preventDefault();
          const startX = event.clientX;
          const startWidth = prefsRef.current.values.sidebarWidth ?? 232;
          let width = startWidth;
          const move = (moveEvent: PointerEvent) => {
            width = Math.min(
              520,
              Math.max(200, startWidth + moveEvent.clientX - startX),
            );
            setSidebarWidth(width);
          };
          const finish = () => {
            document.removeEventListener("pointermove", move);
            document.removeEventListener("pointerup", finish);
            document.body.classList.remove("resizing-sidebar");
            setSidebarWidth(width, true);
          };
          document.body.classList.add("resizing-sidebar");
          document.addEventListener("pointermove", move);
          document.addEventListener("pointerup", finish, { once: true });
        }}
        onKeyDown={(event) => {
          if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
          event.preventDefault();
          setSidebarWidth(
            (prefsRef.current.values.sidebarWidth ?? 232) +
              (event.key === "ArrowRight" ? 8 : -8),
            true,
          );
        }}
      />
    </>
  );
}
