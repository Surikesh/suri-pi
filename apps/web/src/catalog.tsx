import React, { useEffect, useRef, useState } from "react";
import { command, refresh } from "./store.js";
import { DirectoryDialog } from "./directory-picker.js";
import type { Data } from "../../../packages/protocol/src/index.js";

/** Project details and sidebar organization are separate dialogs. */
export function CatalogDialog({
  catalog,
  project,
  close,
  sectionsOnly = false,
}: {
  catalog: Data;
  project?: Data;
  close: () => void;
  sectionsOnly?: boolean;
}) {
  const [name, setName] = useState(project?.label ?? "");
  const [picking, setPicking] = useState(false);
  const [sectionName, setSectionName] = useState("");
  const [error, setError] = useState("");
  const dialog = useRef<HTMLDivElement>(null);
  const current = catalog.projects.find((p: Data) => p.id === project?.id);
  useEffect(() => {
    if (picking) return;
    const prior = document.activeElement as HTMLElement;
    dialog.current?.querySelector<HTMLInputElement>("input")?.focus();
    const escape = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopImmediatePropagation();
        close();
      }
    };
    document.addEventListener("keydown", escape, true);
    return () => {
      document.removeEventListener("keydown", escape, true);
      prior?.focus();
    };
  }, [picking]);
  async function act(action: () => Promise<unknown>) {
    try {
      await action();
      await refresh();
      setError("");
    } catch (e) {
      setError((e as Error).message);
    }
  }
  if (picking && current)
    return (
      <DirectoryDialog project={current} close={() => setPicking(false)} />
    );
  return (
    <div
      className="modal-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div
        className="modal catalog-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={sectionsOnly ? "Sidebar sections" : "Manage project"}
        ref={dialog}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            close();
          }
          if (e.key === "Tab") {
            const items = Array.from(
              dialog.current!.querySelectorAll<HTMLElement>(
                "button:not(:disabled),input,select",
              ),
            );
            e.preventDefault();
            const index = items.indexOf(document.activeElement as HTMLElement);
            items[
              (index + (e.shiftKey ? -1 : 1) + items.length) % items.length
            ]?.focus();
          }
        }}
      >
        <h2>{sectionsOnly ? "Sidebar sections" : "Manage project"}</h2>
        {error && (
          <p role="alert">
            {error} <button onClick={() => setError("")}>Dismiss error</button>
          </p>
        )}
        {!sectionsOnly && (
          <>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void act(async () => {
                  if (current)
                    await command(
                      "project.update",
                      { projectId: current.id, label: name },
                      undefined,
                      current.revision,
                    );
                });
              }}
            >
              <label>
                Project name
                <input
                  aria-label="Project name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </label>
              <button>Save project name</button>
            </form>
            {current && (
              <>
                <label>
                  Section
                  <select
                    aria-label="Project section"
                    value={current.sectionId ?? ""}
                    onChange={(e) =>
                      void act(() =>
                        command(
                          "project.update",
                          { projectId: current.id, sectionId: e.target.value },
                          undefined,
                          current.revision,
                        ),
                      )
                    }
                  >
                    <option value="">Projects</option>
                    <option value="pinned">Pinned</option>
                    {(catalog.sections ?? []).map((s: Data) => (
                      <option key={s.id} value={s.id}>
                        {s.label}
                      </option>
                    ))}
                  </select>
                </label>
                <h3>Workspaces</h3>
                {catalog.workspaces
                  .filter((w: Data) => w.projectId === current.id)
                  .map((w: Data) => (
                    <div key={w.id} className="catalog-workspace">
                      <span>
                        {w.label}
                        <small>{w.root}</small>
                      </span>
                      <button
                        aria-label={`Remove workspace ${w.label}`}
                        onClick={() =>
                          void act(() =>
                            command(
                              "workspace.forget",
                              { workspaceId: w.id },
                              undefined,
                              w.revision,
                            ),
                          )
                        }
                      >
                        Remove from Suri
                      </button>
                    </div>
                  ))}
                <button onClick={() => setPicking(true)}>Add workspace…</button>
              </>
            )}
          </>
        )}
        {sectionsOnly && (
          <>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void act(async () => {
                  await command("section.create", { label: sectionName });
                  setSectionName("");
                });
              }}
            >
              <input
                aria-label="New section name"
                value={sectionName}
                onChange={(e) => setSectionName(e.target.value)}
                required
              />
              <button>Create section</button>
            </form>
            {(catalog.sections ?? []).map((s: Data) => (
              <SectionEditor key={s.id} section={s} act={act} />
            ))}
          </>
        )}
        <div className="actions">
          <button onClick={close}>Done</button>
        </div>
      </div>
    </div>
  );
}
function SectionEditor({
  section,
  act,
}: {
  section: Data;
  act: (f: () => Promise<unknown>) => Promise<void>;
}) {
  const [name, setName] = useState(section.label);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void act(() =>
          command(
            "section.update",
            { sectionId: section.id, label: name },
            undefined,
            section.revision,
          ),
        );
      }}
    >
      <input
        aria-label={`Section name ${section.label}`}
        value={name}
        onChange={(e) => setName(e.target.value)}
        required
      />
      <button>Rename section</button>
      <button
        type="button"
        aria-label={`Move section ${section.label} earlier`}
        onClick={() =>
          void act(() =>
            command(
              "section.update",
              { sectionId: section.id, order: (section.order ?? 0) - 1.5 },
              undefined,
              section.revision,
            ),
          )
        }
      >
        Move earlier
      </button>
      <button
        type="button"
        aria-label={`Move section ${section.label} later`}
        onClick={() =>
          void act(() =>
            command(
              "section.update",
              { sectionId: section.id, order: (section.order ?? 0) + 1.5 },
              undefined,
              section.revision,
            ),
          )
        }
      >
        Move later
      </button>
      <button
        type="button"
        aria-label={`Delete section ${section.label}`}
        onClick={() =>
          void act(() =>
            command(
              "section.delete",
              { sectionId: section.id },
              undefined,
              section.revision,
            ),
          )
        }
      >
        Delete section
      </button>
    </form>
  );
}
