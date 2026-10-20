import type React from "react";
import type { Data } from "../../../../../packages/protocol/src/index.js";
import type { State } from "../../store.js";
import { UpdatesControl } from "../updates/index.js";
import { viewStorage as localStorage } from "../../view-storage.js";
import { Icon } from "../../components/ui.js";

type Setter<T> = React.Dispatch<React.SetStateAction<T>>;

interface HeaderProps {
  state: State;
  session: Data | undefined;
  workspace: Data | undefined;
  navigationToggle: React.RefObject<HTMLButtonElement | null>;
  narrow: boolean;
  sidebar: boolean;
  sidebarCollapsed: boolean;
  setSidebar: Setter<boolean>;
  setSidebarCollapsed: Setter<boolean>;
  search: React.RefObject<HTMLInputElement | null>;
  openSessionMenu: (
    target: Data,
    trigger: HTMLElement,
    x: number,
    y: number,
  ) => void;
  details: boolean;
  setDetails: (value: boolean) => void;
}

export function Header({
  state,
  session,
  workspace,
  navigationToggle,
  narrow,
  sidebar,
  sidebarCollapsed,
  setSidebar,
  setSidebarCollapsed,
  search,
  openSessionMenu,
  details,
  setDetails,
}: HeaderProps) {
  return (
    <header>
      <button
        className="mobile-nav"
        ref={navigationToggle}
        aria-label="Open navigation"
        aria-expanded={narrow ? sidebar : !sidebarCollapsed}
        onClick={() => {
          setSidebar(true);
          setSidebarCollapsed(false);
          localStorage.setItem("suri.sidebarCollapsed", "false");
          requestAnimationFrame(() => search.current?.focus());
        }}
      >
        <Icon name="menu" />
      </button>
      <div className="heading">
        {session ? (
          <button
            className="session-title"
            aria-label="Rename current session"
            onClick={(e) => {
              const rect = e.currentTarget.getBoundingClientRect();
              openSessionMenu(session, e.currentTarget, rect.left, rect.bottom);
            }}
          >
            <strong>{session.name}</strong>
          </button>
        ) : (
          <strong>Suri Pi</strong>
        )}
        <span>{workspace?.label ?? "Your local Pi workspace"}</span>
      </div>
      <UpdatesControl />
      <span
        className={`connection ${state.connected ? "" : "offline"}`}
        role="status"
      >
        {state.connected ? "Connected" : "Disconnected"}
      </span>
      {session && (
        <button
          aria-label="Open workspace details"
          onClick={() => setDetails(!details)}
        >
          <Icon name="panel" />
        </button>
      )}
    </header>
  );
}
