import React from "react";
import {
  activePhases,
  type Data,
} from "../../../../../packages/protocol/src/index.js";
import { command, select, type State } from "../../store.js";
import { viewStorage as localStorage } from "../../view-storage.js";

export function SettingsSession({
  state,
  session,
  workspace,
  running,
  act,
  create,
  historyInput,
  iconInput,
  importPreview,
  setImportPreview,
  importing,
  setImporting,
  setIconTarget,
  tree,
  setTree,
  treeSessionId,
  setTreeSessionId,
  worktrees,
  setWorktrees,
  setSettings,
}: {
  state: State;
  session: Data | undefined;
  workspace: Data;
  running: boolean;
  act: (fn: () => Promise<unknown>) => Promise<void>;
  create: (workspaceId?: string) => Promise<void>;
  historyInput: React.RefObject<HTMLInputElement | null>;
  iconInput: React.RefObject<HTMLInputElement | null>;
  importPreview: Data[];
  setImportPreview: React.Dispatch<React.SetStateAction<Data[]>>;
  importing: boolean;
  setImporting: (value: boolean) => void;
  setIconTarget: (value: Data | undefined) => void;
  tree: Data[];
  setTree: (value: Data[]) => void;
  treeSessionId: string | undefined;
  setTreeSessionId: (value: string | undefined) => void;
  worktrees: Data[];
  setWorktrees: (value: Data[]) => void;
  setSettings: (value: boolean) => void;
}) {
  return (
    <>
      {session && (
        <>
          <h3>Current session</h3>
          <button
            disabled={running}
            onClick={() => historyInput.current?.click()}
          >
            Review Pi histories…
          </button>
          {importPreview.length > 0 && (
            <section className="import-preview" aria-label="Import preview">
              {importPreview.map((candidate, index) => (
                <label key={candidate.grantId}>
                  <input
                    type="checkbox"
                    disabled={candidate.status !== "ready" || importing}
                    checked={Boolean(candidate.selected)}
                    onChange={(event) =>
                      setImportPreview((old) =>
                        old.map((item, itemIndex) =>
                          itemIndex === index
                            ? { ...item, selected: event.target.checked }
                            : item,
                        ),
                      )
                    }
                  />
                  <span>
                    <strong>{candidate.name ?? candidate.fileName}</strong>
                    <small>
                      {candidate.status}
                      {candidate.cwd ? ` · ${candidate.cwd}` : ""}
                      {candidate.reason ? ` · ${candidate.reason}` : ""}
                    </small>
                  </span>
                </label>
              ))}
              <button
                className="primary"
                disabled={
                  importing ||
                  !importPreview.some(
                    (candidate) =>
                      candidate.selected && candidate.status === "ready",
                  )
                }
                onClick={() =>
                  void act(async () => {
                    setImporting(true);
                    try {
                      const selected = importPreview.filter(
                        (candidate) =>
                          candidate.selected && candidate.status === "ready",
                      );
                      const result = await command("session.importBatch", {
                        fileGrantIds: selected.map(
                          (candidate) => candidate.grantId,
                        ),
                        workspaceId: session.workspaceId,
                        runtimeId: session.runtimeId,
                      });
                      const imported = new Set(
                        (result.imported ?? []).map(
                          (item: Data) => item.grantId,
                        ),
                      );
                      const skipped = new Set(
                        (result.skipped ?? []).map(
                          (item: Data) => item.grantId,
                        ),
                      );
                      setImportPreview((old) =>
                        old.map((candidate) => ({
                          ...candidate,
                          selected: false,
                          status: imported.has(candidate.grantId)
                            ? "imported"
                            : skipped.has(candidate.grantId)
                              ? "duplicate"
                              : candidate.status,
                        })),
                      );
                    } finally {
                      setImporting(false);
                    }
                  })
                }
              >
                {importing ? "Importing…" : "Import selected"}
              </button>
            </section>
          )}
          <button
            onClick={() => {
              setIconTarget(session);
              iconInput.current?.click();
            }}
          >
            Choose session icon
          </button>
          <button
            disabled={running}
            onClick={() =>
              void act(async () => {
                setTreeSessionId(session.id);
                setTree(
                  (await command("session.tree", {}, session.id)).entries ?? [],
                );
              })
            }
          >
            Inspect session tree
          </button>
          {tree.map((entry) => (
            <div className="tree-row" key={entry.entryId}>
              <span>
                {entry.role} · {entry.label}
                {entry.activeLeaf ? " · current" : ""}
              </span>
              {entry.role === "user" && (
                <button
                  disabled={activePhases.has(
                    state.catalog.sessions.find(
                      (s: Data) => s.id === (treeSessionId ?? session.id),
                    )?.phase,
                  )}
                  onClick={() =>
                    void act(async () => {
                      const owner = state.catalog.sessions.find(
                        (s: Data) => s.id === (treeSessionId ?? session.id),
                      );
                      const result = await command(
                        "session.branch",
                        { entryId: entry.entryId },
                        owner.id,
                        owner.revision,
                      );
                      if (result.id) {
                        if (result.draft)
                          localStorage.setItem(
                            `suri.draft.${result.id}`,
                            result.draft,
                          );
                        select(result.id);
                        setSettings(false);
                      }
                    })
                  }
                >
                  Branch here
                </button>
              )}
            </div>
          ))}
          <button
            onClick={() =>
              void act(async () =>
                setWorktrees(
                  (
                    await command("workspace.list", {
                      projectId: workspace.projectId,
                    })
                  ).candidates ?? [],
                ),
              )
            }
          >
            Existing Git worktrees
          </button>
          {worktrees.map((w) => (
            <button
              key={w.candidateId}
              onClick={() =>
                void act(async () => {
                  const chosen = await command("workspace.select", {
                    candidateId: w.candidateId,
                    projectId: workspace.projectId,
                  });
                  await create(chosen.id);
                  setSettings(false);
                })
              }
            >
              {w.label} · {w.root}
            </button>
          ))}
          <div className="actions">
            <button
              disabled={running}
              onClick={() =>
                void act(() => command("session.resume", {}, session.id))
              }
            >
              Resume
            </button>
          </div>
        </>
      )}
    </>
  );
}
