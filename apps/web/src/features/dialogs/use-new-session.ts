import { useRef, useState } from "react";
import { type Data } from "../../../../../packages/protocol/src/index.js";
import { type State } from "../../store.js";

export function useNewSessionState() {
  const [newSessionDialog, setNewSessionDialog] = useState(false);
  const [newSessionQuery, setNewSessionQuery] = useState("");
  const [newSessionProjectId, setNewSessionProjectId] = useState<
    string | undefined
  >();
  const [newSessionActive, setNewSessionActive] = useState(0);
  const newSessionInput = useRef<HTMLInputElement>(null);
  const newSessionReturnFocus = useRef<HTMLElement | null>(null);
  return {
    newSessionDialog,
    setNewSessionDialog,
    newSessionQuery,
    setNewSessionQuery,
    newSessionProjectId,
    setNewSessionProjectId,
    newSessionActive,
    setNewSessionActive,
    newSessionInput,
    newSessionReturnFocus,
  };
}

export type NewSessionState = ReturnType<typeof useNewSessionState>;

export function createNewSessionController({
  state,
  newSession,
  currentProject,
  setDirectoryDialog,
  act,
  create,
}: {
  state: State;
  newSession: NewSessionState;
  currentProject: Data | undefined;
  setDirectoryDialog: (value: Data | null | undefined) => void;
  act: (fn: () => Promise<unknown>) => Promise<void>;
  create: (workspaceId?: string) => Promise<void>;
}) {
  const {
    setNewSessionDialog,
    newSessionQuery,
    setNewSessionQuery,
    newSessionProjectId,
    setNewSessionProjectId,
    newSessionActive,
    setNewSessionActive,
    newSessionInput,
    newSessionReturnFocus,
  } = newSession;
  const newSessionProjects = state.catalog.projects.filter((project: Data) =>
    state.catalog.workspaces.some(
      (candidate: Data) => candidate.projectId === project.id,
    ),
  );
  const selectedNewSessionProject = newSessionProjects.find(
    (project: Data) => project.id === newSessionProjectId,
  );
  const newSessionNeedle = newSessionQuery.trim().toLowerCase();
  const newSessionMatches = newSessionProjects.filter(
    (project: Data) =>
      project.id === selectedNewSessionProject?.id ||
      !newSessionNeedle ||
      `${project.label} ${project.root ?? ""}`
        .toLowerCase()
        .includes(newSessionNeedle),
  );
  const openNewSessionDialog = (trigger?: HTMLElement) => {
    const project = currentProject ?? newSessionProjects[0];
    if (!project) {
      setDirectoryDialog(null);
      return;
    }
    newSessionReturnFocus.current =
      trigger ?? (document.activeElement as HTMLElement | null);
    setNewSessionQuery(project.label);
    setNewSessionProjectId(project.id);
    setNewSessionActive(0);
    setNewSessionDialog(true);
    requestAnimationFrame(() => {
      newSessionInput.current?.focus();
      newSessionInput.current?.select();
    });
  };
  const closeNewSessionDialog = () => {
    setNewSessionDialog(false);
    requestAnimationFrame(() => newSessionReturnFocus.current?.focus());
  };
  const createNewSessionForProject = async (project?: Data) => {
    const target =
      project ??
      newSessionMatches[newSessionActive] ??
      selectedNewSessionProject;
    const targetWorkspace = state.catalog.workspaces.find(
      (candidate: Data) => candidate.projectId === target?.id,
    );
    if (!targetWorkspace) return;
    setNewSessionDialog(false);
    await act(() => create(targetWorkspace.id));
  };
  return {
    newSessionMatches,
    selectedNewSessionProject,
    openNewSessionDialog,
    closeNewSessionDialog,
    createNewSessionForProject,
  };
}
