import React from "react";
import { type Data } from "../../../../../packages/protocol/src/index.js";
import { ActionError, Icon } from "../../components/ui.js";
import { dismiss, type State } from "../../store.js";
import { SettingsRuntime } from "./settings-runtime.js";
import { SettingsSession } from "./settings-session.js";

export function SettingsDialog({
  settings,
  setSettings,
  state,
  prefs,
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
  patchPreferences,
}: {
  settings: boolean;
  setSettings: (value: boolean) => void;
  state: State;
  prefs: Data;
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
  patchPreferences: (patch: Data) => Promise<unknown>;
}) {
  return (
    <>
      {settings && (
        <div className="modal-backdrop">
          <section
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="settings-title"
          >
            <div className="detail-top">
              <h2 id="settings-title">Settings</h2>
              <button
                autoFocus
                aria-label="Close settings"
                onClick={() => setSettings(false)}
              >
                <Icon name="close" />
              </button>
            </div>
            <ActionError message={state.error} onDismiss={dismiss} />
            <p>Appearance · Light</p>
            <p className="muted">
              Suri owns your interface preferences independently of Pi.
            </p>
            <p className="muted">
              Resize the sidebar directly by dragging its right edge.
            </p>
            <label>
              Text size
              <select
                aria-label="Text size"
                value={prefs.values.fontScale ?? 1}
                onChange={(e) =>
                  void patchPreferences({ fontScale: Number(e.target.value) })
                }
              >
                <option value="1">100%</option>
                <option value="1.25">125%</option>
                <option value="1.5">150%</option>
                <option value="2">200%</option>
              </select>
            </label>
            <SettingsRuntime
              state={state}
              session={session}
              running={running}
              act={act}
            />
            <SettingsSession
              state={state}
              session={session}
              workspace={workspace}
              running={running}
              act={act}
              create={create}
              historyInput={historyInput}
              iconInput={iconInput}
              importPreview={importPreview}
              setImportPreview={setImportPreview}
              importing={importing}
              setImporting={setImporting}
              setIconTarget={setIconTarget}
              tree={tree}
              setTree={setTree}
              treeSessionId={treeSessionId}
              setTreeSessionId={setTreeSessionId}
              worktrees={worktrees}
              setWorktrees={setWorktrees}
              setSettings={setSettings}
            />
          </section>
        </div>
      )}
    </>
  );
}
