import { command, report } from "../../store.js";
import { FileTypeIcon } from "../../file-preview.js";
import { diffStats, type ChangedFile } from "../../change-review.js";
import { BinaryPreview, DiffPreview } from "../../diff-preview.js";
import type { useChanges } from "./use-changes.js";

function changeLabel(file: ChangedFile) {
  if (file.untracked) return "Added";
  const labels: Record<string, string> = {
    A: "Added",
    D: "Deleted",
    M: "Modified",
    R: "Renamed",
    T: "Type changed",
    U: "Unmerged",
  };
  return labels[file.code] ?? "Changed";
}
export function ChangesPane({
  tab,
  transientChange,
  onPinChange,
  workspaceId,
  changes,
}: {
  tab: string;
  transientChange?: string;
  onPinChange?: (path: string) => void;
  workspaceId: string;
  changes: ReturnType<typeof useChanges>;
}) {
  const {
    changeFiles,
    changeFilter,
    setChangeFilter,
    filteredChangeFiles,
    selectedChange,
    setSelectedChange,
    patches,
    changeDiff,
    changesLoading,
    changeError,
    changeNotice,
    refreshChanges,
    changeAction,
  } = changes;
  return (
    <>
      {tab === "Changes" && transientChange && (
        <div className="changes-current transient-change-actions">
          <button onClick={() => onPinChange?.(selectedChange)}>
            Pin preview
          </button>
        </div>
      )}
      {tab === "Changes" && (
        <section className="changes-review" aria-label="Workspace changes">
          <div className="changes-sidebar">
            <div className="changes-summary">
              <label className="changes-filter">
                <svg viewBox="0 0 20 20" aria-hidden="true">
                  <circle cx="8.5" cy="8.5" r="5.5" />
                  <path d="m12.5 12.5 4 4" />
                </svg>
                <input
                  type="search"
                  aria-label="Filter changed files"
                  placeholder="Filter changed files"
                  value={changeFilter}
                  onChange={(event) => setChangeFilter(event.target.value)}
                />
              </label>
              <button
                aria-label="Refresh changes"
                title="Refresh changes"
                disabled={changesLoading}
                onClick={() => void refreshChanges(selectedChange)}
              >
                ↻
              </button>
              <span className="changes-count" aria-live="polite">
                {changesLoading
                  ? "Refreshing…"
                  : changeFilter.trim()
                    ? `${filteredChangeFiles.length} of ${changeFiles.length} files`
                    : `${changeFiles.length} changed ${changeFiles.length === 1 ? "file" : "files"}`}
              </span>
            </div>
            {changeError && !changeFiles.length ? (
              <p className="file-state error" role="alert">
                {changeError}
              </p>
            ) : !changesLoading && !changeFiles.length ? (
              <div className="changes-empty">
                <strong>No local changes</strong>
                <span>Edited files will appear here.</span>
              </div>
            ) : (
              <div
                className="change-file-list"
                role="listbox"
                aria-label="Changed files"
                onKeyDown={(event) => {
                  const items = Array.from(
                    event.currentTarget.querySelectorAll<HTMLButtonElement>(
                      '[role="option"]',
                    ),
                  );
                  const index = items.indexOf(
                    event.target as HTMLButtonElement,
                  );
                  const next =
                    event.key === "ArrowDown"
                      ? items[index + 1]
                      : event.key === "ArrowUp"
                        ? items[index - 1]
                        : event.key === "Home"
                          ? items[0]
                          : event.key === "End"
                            ? items.at(-1)
                            : undefined;
                  if (next) {
                    event.preventDefault();
                    next.focus();
                    next.click();
                  }
                }}
              >
                {filteredChangeFiles.length === 0 && changeFilter.trim() && (
                  <div className="changes-empty changes-filter-empty">
                    <strong>No matching files</strong>
                    <span>Try a different name or path.</span>
                  </div>
                )}
                {filteredChangeFiles.map((file) => (
                  <button
                    key={file.path}
                    role="option"
                    aria-selected={selectedChange === file.path}
                    className="change-file"
                    title={file.path}
                    onClick={() => {
                      setSelectedChange(file.path);
                      onPinChange?.(file.path);
                    }}
                    onDoubleClick={() =>
                      void command("file.open", {
                        workspaceId,
                        path: file.path,
                      }).catch(report)
                    }
                  >
                    <FileTypeIcon path={file.path} />
                    <span className="change-file-copy">
                      <strong>{file.path.split("/").at(-1)}</strong>
                      <small>
                        {file.renamedFrom
                          ? `${file.renamedFrom} → ${file.path}`
                          : file.path.includes("/")
                            ? file.path.split("/").slice(0, -1).join("/")
                            : changeLabel(file)}
                      </small>
                    </span>
                    <span className={`change-code ${file.code.toLowerCase()}`}>
                      {file.code}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>
          <div className="change-preview">
            {selectedChange ? (
              <>
                <header className="change-preview-header">
                  <div>
                    <strong title={selectedChange}>{selectedChange}</strong>
                    {changeDiff &&
                      (() => {
                        const stats = diffStats(changeDiff);
                        return (
                          <small>
                            <span className="diff-additions">
                              +{stats.additions}
                            </span>
                            <span className="diff-deletions">
                              −{stats.deletions}
                            </span>
                          </small>
                        );
                      })()}
                  </div>
                  <div className="change-actions">
                    <button onClick={() => void changeAction("copyPath")}>
                      Copy path
                    </button>
                    <button onClick={() => void changeAction("copy")}>
                      Copy file
                    </button>
                    <button onClick={() => void changeAction("open")}>
                      Open
                    </button>
                    <button onClick={() => void changeAction("openWith")}>
                      Open With…
                    </button>
                    <button onClick={() => void changeAction("reveal")}>
                      Reveal
                    </button>
                  </div>
                </header>
                {changeNotice && (
                  <p className="change-notice" aria-live="polite">
                    {changeNotice}
                  </p>
                )}
                {changeError ? (
                  <p className="file-state error" role="alert">
                    {changeError}
                  </p>
                ) : (
                  <div
                    className="change-patches"
                    aria-label={`Changes in ${selectedChange}`}
                  >
                    {!patches ||
                    patches.path !== selectedChange ||
                    patches.files !== changeFiles ||
                    changesLoading ? (
                      <p className="file-state" role="status">
                        Loading changes…
                      </p>
                    ) : (
                      <>
                        {!changeDiff.trim() && (
                          <div className="changes-empty">
                            <strong>No current diff for this file</strong>
                            <span>
                              This link refers to an earlier edit. It may have
                              been committed, reverted, or removed. Historical
                              snapshots are not stored.
                            </span>
                          </div>
                        )}
                        {/binary/i.test(changeDiff) ? (
                          <BinaryPreview
                            path={selectedChange}
                            file={patches.binaryFile}
                            error={patches.binaryReadError}
                          />
                        ) : (
                          <>
                            <DiffPreview
                              text={patches.staged}
                              path={selectedChange}
                              label="Staged · HEAD → index"
                            />
                            <DiffPreview
                              text={patches.unstaged}
                              path={selectedChange}
                              label={
                                changeFiles.find(
                                  (file) => file.path === selectedChange,
                                )?.untracked
                                  ? "New file · working tree"
                                  : "Unstaged · index → working tree"
                              }
                            />
                          </>
                        )}
                      </>
                    )}
                  </div>
                )}
              </>
            ) : (
              <div className="changes-empty changes-empty-preview">
                <strong>Select a changed file</strong>
                <span>Its patch will appear here.</span>
              </div>
            )}
          </div>
        </section>
      )}
    </>
  );
}
