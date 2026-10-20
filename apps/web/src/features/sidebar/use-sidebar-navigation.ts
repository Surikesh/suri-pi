import type React from "react";
import {
  activePhases,
  type Data,
  type Message,
} from "../../../../../packages/protocol/src/index.js";
import { command, type State } from "../../store.js";

type Setter<T> = React.Dispatch<React.SetStateAction<T>>;

export interface SessionTooltip {
  sessionId: string;
  x: number;
  y: number;
  excerpt?: string;
  speaker?: "Pi" | "You";
  loaded: boolean;
}

/** State declared in App (shared with the shell, menus, escape handling and tooltip render). */
interface SidebarNavigationInput {
  state: State;
  filter: string;
  archived: boolean;
  prefs: Data;
  prefsRef: { current: Data };
  patchPreferences: (patch: Data) => unknown;
  act: (fn: () => Promise<unknown>) => Promise<unknown>;
  dragSource: { current: string };
  dropMarker: { key: string; edge: string } | undefined;
  setSessionTooltip: Setter<SessionTooltip | undefined>;
  sessionTooltipTimer: {
    current: ReturnType<typeof setTimeout> | undefined;
  };
  sessionTooltipRequest: { current: number };
}

export function useSidebarNavigation({
  state,
  filter,
  archived,
  prefs,
  prefsRef,
  patchPreferences,
  act,
  dragSource,
  dropMarker,
  setSessionTooltip,
  sessionTooltipTimer,
  sessionTooltipRequest,
}: SidebarNavigationInput) {
  const activityAt = (candidate: Data) =>
    Date.parse(candidate.updatedAt ?? candidate.createdAt ?? "") || 0;
  const projectForSession = (candidate: Data) => {
    const owner = state.catalog.workspaces.find(
      (item: Data) => item.id === candidate.workspaceId,
    );
    return state.catalog.projects.find(
      (item: Data) => item.id === owner?.projectId,
    );
  };
  const navigationSession = (candidate: Data) =>
    candidate.id === state.selected ||
    candidate.hasConversation ||
    candidate.name !== "New session" ||
    activePhases.has(candidate.phase);
  const sessionVisible = (candidate: Data, project?: Data) => {
    const needle = filter.trim().toLowerCase();
    return (
      !!project &&
      navigationSession(candidate) &&
      !!candidate.archived === archived &&
      (!prefs.values.navigationUnreadOnly || candidate.unread) &&
      (!prefs.values.navigationRecentOnly ||
        activityAt(candidate) >= Date.now() - 7 * 24 * 60 * 60 * 1000) &&
      (!needle ||
        candidate.name.toLowerCase().includes(needle) ||
        project?.label?.toLowerCase().includes(needle))
    );
  };
  const orderSessions = (items: Data[]) =>
    [...items].sort(
      (a, b) =>
        Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) ||
        (prefs.values.navigationOrder === "updated"
          ? activityAt(b) - activityAt(a)
          : (a.order ?? Number.MAX_SAFE_INTEGER) -
              (b.order ?? Number.MAX_SAFE_INTEGER) ||
            String(b.createdAt ?? "").localeCompare(String(a.createdAt ?? ""))),
    );
  const orderedProjects = [...state.catalog.projects].sort((a, b) => {
    if (prefs.values.navigationOrder !== "updated")
      return (a.order ?? 0) - (b.order ?? 0);
    const newest = (project: Data) => {
      const workspaceIds = new Set(
        state.catalog.workspaces
          .filter((item: Data) => item.projectId === project.id)
          .map((item: Data) => item.id),
      );
      return Math.max(
        0,
        ...state.catalog.sessions
          .filter(
            (item: Data) =>
              workspaceIds.has(item.workspaceId) && navigationSession(item),
          )
          .map(activityAt),
      );
    };
    return newest(b) - newest(a);
  });
  const navigationSections: Data[] = [
    { id: "pinned", label: "Pinned", collapsed: prefs.values.pinnedCollapsed },
    { id: "", label: "Projects", collapsed: prefs.values.generalCollapsed },
    ...[...(state.catalog.sections ?? [])].sort(
      (a: Data, b: Data) => a.order - b.order,
    ),
  ];
  const projectCollapsed = (project: Data) =>
    !!prefs.values.projectCollapsed?.[project.id];
  const projectSessionsExpanded = (project: Data) =>
    !!prefs.values.projectSessionsExpanded?.[project.id];
  const patchProjectPreference = (
    key: "projectCollapsed" | "projectSessionsExpanded",
    projectId: string,
    value: boolean,
  ) =>
    patchPreferences({
      [key]: { ...(prefsRef.current.values[key] ?? {}), [projectId]: value },
    });
  const sessionsForProject = (project: Data) => {
    const workspaceIds = new Set(
      state.catalog.workspaces
        .filter((item: Data) => item.projectId === project.id)
        .map((item: Data) => item.id),
    );
    return orderSessions(
      state.catalog.sessions.filter(
        (candidate: Data) =>
          !candidate.pinned &&
          workspaceIds.has(candidate.workspaceId) &&
          sessionVisible(candidate, project),
      ),
    );
  };
  const displayedProjectSessionIds = (project: Data) => {
    const sessions = sessionsForProject(project);
    if (filter || projectSessionsExpanded(project) || sessions.length <= 5)
      return new Set(sessions.map((candidate: Data) => candidate.id));
    const visible = sessions.slice(0, 5);
    const active = sessions.find(
      (candidate: Data) => candidate.id === state.selected,
    );
    if (
      active &&
      !visible.some((candidate: Data) => candidate.id === active.id)
    )
      visible[visible.length - 1] = active;
    return new Set(visible.map((candidate: Data) => candidate.id));
  };
  const allProjectsCollapsed =
    orderedProjects.length > 0 && orderedProjects.every(projectCollapsed);
  const moveNavigation = async (source: string, section: Data, before?: Data) =>
    act(async () => {
      const [kind, id] = source.split(":");
      if (kind === "project") {
        const item = state.catalog.projects.find((p: Data) => p.id === id);
        if (!item || item.id === before?.id) return;
        const siblings = orderedProjects.filter(
          (p: Data) => (p.sectionId ?? "") === section.id && p.id !== id,
        );
        const index = before
          ? siblings.findIndex((p: Data) => p.id === before.id)
          : siblings.length;
        siblings.splice(Math.max(0, index), 0, item);
        for (const [order, project] of siblings.entries())
          await command(
            "project.update",
            { projectId: project.id, sectionId: section.id, order },
            undefined,
            project.revision,
          );
        await patchPreferences({ navigationOrder: "manual" });
      } else if (kind === "section" && section.revision) {
        const sections = navigationSections.filter(
          (s: Data) => s.revision && s.id !== id,
        );
        const item = navigationSections.find((s: Data) => s.id === id);
        if (!item) return;
        sections.splice(
          sections.findIndex((s: Data) => s.id === section.id),
          0,
          item,
        );
        for (const [order, s] of sections.entries())
          await command(
            "section.update",
            { sectionId: s.id, order },
            undefined,
            s.revision,
          );
      }
    });
  const manualNavigation = prefs.values.navigationOrder === "manual";
  const sessionSiblings = (candidate: Data) =>
    orderSessions(
      state.catalog.sessions.filter(
        (item: Data) =>
          item.workspaceId === candidate.workspaceId &&
          !!item.pinned === !!candidate.pinned &&
          !!item.archived === !!candidate.archived,
      ),
    );
  const moveSession = (source: string, target: Data, after: boolean) =>
    act(async () => {
      if (!manualNavigation || !source.startsWith("session:")) return;
      const id = source.slice(8);
      const siblings = sessionSiblings(target);
      const item = siblings.find((value: Data) => value.id === id);
      if (!item || id === target.id) return;
      const ordered = siblings.filter((value: Data) => value.id !== id);
      ordered.splice(
        ordered.findIndex((value: Data) => value.id === target.id) +
          Number(after),
        0,
        item,
      );
      await command("session.reorder", {
        sessionIds: ordered.map((value: Data) => value.id),
        revisions: Object.fromEntries(
          ordered.map((value: Data) => [value.id, value.revision]),
        ),
      });
    });
  const edgeAt = (
    event: React.DragEvent,
    row: HTMLElement = event.currentTarget as HTMLElement,
  ) =>
    event.clientY >
    row.getBoundingClientRect().top + row.getBoundingClientRect().height / 2
      ? "after"
      : "before";
  const canDropSession = (target: Data) =>
    dragSource.current.startsWith("session:") &&
    sessionSiblings(target).some(
      (item: Data) => `session:${item.id}` === dragSource.current,
    );
  const dropClass = (key: string) =>
    dropMarker?.key === key ? ` drop-${dropMarker.edge}` : "";
  const projectDrop = (
    source: string,
    section: Data,
    target: Data,
    after: boolean,
  ) => {
    const siblings = orderedProjects.filter(
      (item: Data) => (item.sectionId ?? "") === section.id,
    );
    return moveNavigation(
      source,
      section,
      after
        ? siblings[
            siblings.findIndex((item: Data) => item.id === target.id) + 1
          ]
        : target,
    );
  };
  const showSessionTooltip = (
    candidate: Data,
    target: HTMLElement,
    delay = 320,
  ) => {
    if (sessionTooltipTimer.current) clearTimeout(sessionTooltipTimer.current);
    const rect = target.getBoundingClientRect();
    const request = ++sessionTooltipRequest.current;
    sessionTooltipTimer.current = setTimeout(() => {
      setSessionTooltip({
        sessionId: candidate.id,
        x: Math.max(12, Math.min(rect.right + 10, window.innerWidth - 352)),
        y: Math.max(12, Math.min(rect.top - 10, window.innerHeight - 176)),
        loaded: false,
      });
      void command("session.history", { limit: 24 }, candidate.id)
        .then((history) => {
          if (sessionTooltipRequest.current !== request) return;
          const latest = [...(history.messages ?? [])]
            .reverse()
            .map((message: Message) => ({
              role: message.role,
              text: message.blocks
                .map((block) => block.text ?? "")
                .join("\n")
                .replace(/\s+/g, " ")
                .trim(),
            }))
            .find(
              (message) =>
                message.text && ["assistant", "user"].includes(message.role),
            );
          setSessionTooltip((current) => {
            if (!current || current.sessionId !== candidate.id) return current;
            return {
              ...current,
              excerpt: latest?.text,
              speaker: latest?.role === "user" ? "You" : "Pi",
              loaded: true,
            };
          });
        })
        .catch(() => {
          if (sessionTooltipRequest.current !== request) return;
          setSessionTooltip((current) => {
            if (!current || current.sessionId !== candidate.id) return current;
            return { ...current, loaded: true };
          });
        });
    }, delay);
  };
  const hideSessionTooltip = () => {
    if (sessionTooltipTimer.current) clearTimeout(sessionTooltipTimer.current);
    sessionTooltipRequest.current += 1;
    setSessionTooltip(undefined);
  };
  return {
    orderedProjects,
    navigationSections,
    projectCollapsed,
    projectSessionsExpanded,
    patchProjectPreference,
    sessionsForProject,
    displayedProjectSessionIds,
    allProjectsCollapsed,
    moveNavigation,
    manualNavigation,
    sessionSiblings,
    moveSession,
    edgeAt,
    canDropSession,
    dropClass,
    projectDrop,
    showSessionTooltip,
    hideSessionTooltip,
    orderSessions,
    sessionVisible,
    projectForSession,
  };
}

export type SidebarNavigation = ReturnType<typeof useSidebarNavigation>;
