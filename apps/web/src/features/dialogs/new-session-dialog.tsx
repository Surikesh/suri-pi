import React from "react";
import { type Data } from "../../../../../packages/protocol/src/index.js";
import { FolderIcon } from "../../icons.js";
import { Icon } from "../../components/ui.js";
import { type NewSessionState } from "./use-new-session.js";

export function NewSessionDialog({
  newSession,
  newSessionMatches,
  selectedNewSessionProject,
  closeNewSessionDialog,
  createNewSessionForProject,
}: {
  newSession: NewSessionState;
  newSessionMatches: Data[];
  selectedNewSessionProject: Data | undefined;
  closeNewSessionDialog: () => void;
  createNewSessionForProject: (project?: Data) => Promise<void>;
}) {
  const {
    newSessionDialog,
    newSessionQuery,
    setNewSessionQuery,
    setNewSessionProjectId,
    newSessionActive,
    setNewSessionActive,
    newSessionInput,
  } = newSession;
  return (
    <>
      {newSessionDialog && (
        <div
          className="modal-backdrop new-session-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) closeNewSessionDialog();
          }}
        >
          <section
            className="modal new-session-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="new-session-title"
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                closeNewSessionDialog();
                return;
              }
              if (event.key === "ArrowDown" && newSessionMatches.length) {
                event.preventDefault();
                setNewSessionProjectId(undefined);
                setNewSessionActive(
                  (newSessionActive + 1) % newSessionMatches.length,
                );
              }
              if (event.key === "ArrowUp" && newSessionMatches.length) {
                event.preventDefault();
                setNewSessionProjectId(undefined);
                setNewSessionActive(
                  (newSessionActive - 1 + newSessionMatches.length) %
                    newSessionMatches.length,
                );
              }
              if (event.key === "Enter") {
                event.preventDefault();
                void createNewSessionForProject();
              }
            }}
          >
            <div className="new-session-heading">
              <h2 id="new-session-title">New session</h2>
              <kbd>⌃⌥N</kbd>
            </div>
            <label className="new-session-project-field">
              <span>Project</span>
              <span className="new-session-search">
                <Icon name="search" />
                <input
                  ref={newSessionInput}
                  role="combobox"
                  aria-label="Project for new session"
                  aria-controls="new-session-projects"
                  aria-expanded="true"
                  aria-autocomplete="list"
                  aria-activedescendant={
                    newSessionMatches[newSessionActive]
                      ? `new-session-project-${newSessionMatches[newSessionActive].id}`
                      : undefined
                  }
                  value={newSessionQuery}
                  onChange={(event) => {
                    setNewSessionQuery(event.target.value);
                    setNewSessionProjectId(undefined);
                    setNewSessionActive(0);
                  }}
                />
              </span>
            </label>
            <div
              id="new-session-projects"
              className="new-session-projects"
              role="listbox"
              aria-label="Projects"
            >
              {newSessionMatches.map((project: Data, index: number) => (
                <button
                  id={`new-session-project-${project.id}`}
                  key={project.id}
                  role="option"
                  aria-selected={
                    project.id === selectedNewSessionProject?.id ||
                    (!selectedNewSessionProject && index === newSessionActive)
                  }
                  className={
                    project.id === selectedNewSessionProject?.id ||
                    (!selectedNewSessionProject && index === newSessionActive)
                      ? "active"
                      : undefined
                  }
                  onMouseEnter={() => {
                    setNewSessionProjectId(undefined);
                    setNewSessionActive(index);
                  }}
                  onClick={() => void createNewSessionForProject(project)}
                >
                  <span className="new-session-project-icon">
                    {project.iconId || project.autoIconId ? (
                      <img
                        src={`/v1/assets/${project.iconId || project.autoIconId}`}
                        alt=""
                      />
                    ) : (
                      <FolderIcon />
                    )}
                  </span>
                  <span>
                    <strong>{project.label}</strong>
                    <small>{project.root}</small>
                  </span>
                </button>
              ))}
              {newSessionMatches.length === 0 && <p>No matching projects</p>}
            </div>
            <div className="actions">
              <button onClick={closeNewSessionDialog}>Cancel</button>
              <button
                className="primary"
                disabled={newSessionMatches.length === 0}
                onClick={() => void createNewSessionForProject()}
              >
                Create session
              </button>
            </div>
          </section>
        </div>
      )}
    </>
  );
}
