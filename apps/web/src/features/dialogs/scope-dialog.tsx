import React from "react";
import { type Data } from "../../../../../packages/protocol/src/index.js";
import { Icon } from "../../components/ui.js";
import { searchModels } from "../../model-search.js";

export function ScopeDialog({
  scopePanel,
  setScopePanel,
  scopeToken,
  scopeDraft,
  setScopeDraft,
  scopeSearch,
  setScopeSearch,
  scopePhase,
  setScopePhase,
  scopeError,
  setScopeError,
  scopeOffset,
  setScopeOffset,
  session,
  models,
  loadModels,
  patchPreferences,
}: {
  scopePanel: boolean;
  setScopePanel: (value: boolean) => void;
  scopeToken: React.MutableRefObject<number>;
  scopeDraft: string[] | null;
  setScopeDraft: (value: string[] | null) => void;
  scopeSearch: string;
  setScopeSearch: (value: string) => void;
  scopePhase: "loading" | "ready" | "error";
  setScopePhase: (value: "loading" | "ready" | "error") => void;
  scopeError: string;
  setScopeError: (value: string) => void;
  scopeOffset: number;
  setScopeOffset: React.Dispatch<React.SetStateAction<number>>;
  session: Data | undefined;
  models: Data[];
  loadModels: (session: Data, force: boolean) => Promise<unknown>;
  patchPreferences: (patch: Data) => Promise<unknown>;
}) {
  return (
    <>
      {scopePanel && (
        <div className="modal-backdrop">
          <section
            className="modal model-scope"
            role="dialog"
            aria-modal="true"
            aria-labelledby="scope-title"
          >
            <div className="detail-top">
              <h2 id="scope-title">Models in picker</h2>
              <button
                aria-label="Close model scope"
                onClick={() => {
                  scopeToken.current++;
                  setScopePanel(false);
                }}
              >
                <Icon name="close" />
              </button>
            </div>
            <p className="muted">
              Choose a smaller working set without changing Pi credentials or
              providers.
            </p>
            <input
              autoFocus
              type="search"
              aria-label="Search models"
              placeholder="Search models"
              value={scopeSearch}
              onChange={(event) => {
                setScopeSearch(event.target.value);
                setScopeOffset(0);
              }}
            />
            {scopePhase === "loading" && <p role="status">Loading models…</p>}
            {scopePhase === "error" && (
              <p role="alert">
                {scopeError}{" "}
                <button
                  onClick={() => {
                    if (!session) return;
                    const current = ++scopeToken.current;
                    setScopePhase("loading");
                    void loadModels(session, true)
                      .then(() => {
                        if (scopeToken.current === current)
                          setScopePhase("ready");
                      })
                      .catch((cause) => {
                        if (scopeToken.current === current) {
                          setScopeError((cause as Error).message);
                          setScopePhase("error");
                        }
                      });
                  }}
                >
                  Retry
                </button>
              </p>
            )}
            <div className="model-scope-list">
              {scopePhase === "ready" &&
                searchModels(models, scopeSearch)
                  .slice(scopeOffset, scopeOffset + 60)
                  .map((model) => {
                    const key = `${model.provider}/${model.id}`;
                    const checked =
                      scopeDraft === null || scopeDraft.includes(key);
                    return (
                      <label key={key}>
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => {
                            const all = models.map(
                              (item) => `${item.provider}/${item.id}`,
                            );
                            const current =
                              scopeDraft === null ? all : scopeDraft;
                            setScopeDraft(
                              checked
                                ? current.filter((item) => item !== key)
                                : [...current, key],
                            );
                          }}
                        />
                        <span>
                          <strong>{model.name ?? model.id}</strong>
                          <small>{model.provider}</small>
                        </span>
                      </label>
                    );
                  })}
            </div>
            {scopePhase === "ready" && scopeOffset > 0 && (
              <button onClick={() => setScopeOffset((value) => value - 60)}>
                Previous models
              </button>
            )}
            {scopePhase === "ready" &&
              searchModels(models, scopeSearch).length > scopeOffset + 60 && (
                <button onClick={() => setScopeOffset((value) => value + 60)}>
                  Next models
                </button>
              )}
            <div className="actions">
              <button onClick={() => setScopeDraft(null)}>Enable all</button>
              <button
                onClick={() => {
                  scopeToken.current++;
                  setScopePanel(false);
                  setScopeDraft(null);
                }}
              >
                Cancel
              </button>
              <button
                className="primary"
                disabled={scopePhase !== "ready"}
                onClick={() => {
                  void patchPreferences({ scopedModels: scopeDraft });
                  scopeToken.current++;
                  setScopePanel(false);
                }}
              >
                Save scope
              </button>
            </div>
          </section>
        </div>
      )}
    </>
  );
}
