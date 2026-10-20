import type React from "react";
import type { Data } from "../../../../../packages/protocol/src/index.js";
import type { State } from "../../store.js";
import type {
  SessionTooltip,
  SidebarNavigation,
} from "./use-sidebar-navigation.js";

type Setter<T> = React.Dispatch<React.SetStateAction<T>>;

export interface SidebarProps {
  state: State;
  navigation: SidebarNavigation;
  sidebar: boolean;
  setSidebar: Setter<boolean>;
  sidebarCollapsed: boolean;
  setSidebarCollapsed: Setter<boolean>;
  commandHeld: boolean;
  narrow: boolean;
  navigationToggle: React.RefObject<HTMLButtonElement | null>;
  openNewSessionDialog: (trigger?: HTMLElement) => void;
  search: React.RefObject<HTMLInputElement | null>;
  filter: string;
  setFilter: Setter<string>;
  viewOptionsTrigger: React.RefObject<HTMLButtonElement | null>;
  viewOptions: boolean;
  setViewOptions: Setter<boolean>;
  setDirectoryDialog: Setter<Data | null | undefined>;
  setCatalogDialog: Setter<Data | null | undefined>;
  prefs: Data;
  prefsRef: { current: Data };
  patchPreferences: (patch: Data) => unknown;
  act: (fn: () => Promise<unknown>) => Promise<unknown>;
  create: (workspaceId?: string) => Promise<unknown>;
  openProjectMenu: (
    target: Data,
    trigger: HTMLElement,
    x: number,
    y: number,
  ) => void;
  openSessionMenu: (
    target: Data,
    trigger: HTMLElement,
    x: number,
    y: number,
  ) => void;
  setIconTarget: Setter<Data | undefined>;
  iconInput: React.RefObject<HTMLInputElement | null>;
  archived: boolean;
  setArchived: Setter<boolean>;
  setSettings: Setter<boolean>;
  setSidebarWidth: (width: number, persist?: boolean) => void;
  startNavigationDrag: (
    event: React.DragEvent,
    source: string,
    row: HTMLElement,
  ) => void;
  endNavigationDrag: () => void;
  dragSource: { current: string };
  setDropMarker: Setter<{ key: string; edge: string } | undefined>;
  sessionTooltip: SessionTooltip | undefined;
}
