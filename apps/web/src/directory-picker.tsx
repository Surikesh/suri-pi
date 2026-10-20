import React, { useEffect, useRef, useState } from "react";
import { command, refresh } from "./store.js";
import type { Data } from "../../../packages/protocol/src/index.js";
import { FolderIcon } from "./icons.js";

export function DirectoryDialog({
  project,
  close,
  added,
}: {
  project?: Data;
  close: () => void;
  added?: (project: Data) => void;
}) {
  const [listing, setListing] = useState<Data>();
  const [path, setPath] = useState(project?.root ?? "");
  const [hidden, setHidden] = useState(false);
  const [busy, setBusy] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [prefix, setPrefix] = useState("");
  const generation = useRef(0);
  const pendingFilter = useRef<ReturnType<typeof setTimeout>>(undefined);
  const currentDirectory = useRef<Data>(undefined);
  const composing = useRef(false);
  const dialog = useRef<HTMLDivElement>(null);
  const title = project ? "Add workspace" : "Add project";
  async function browse(next?: string) {
    clearTimeout(pendingFilter.current);
    const current = ++generation.current;
    setBusy(true);
    setError("");
    setListing(undefined);
    setPrefix("");
    try {
      const result = await command(
        "directory.list",
        next ? { path: next } : {},
      );
      if (current !== generation.current) return;
      setListing(result);
      currentDirectory.current = { ...result, requestedPath: next };
      setPath(result.path);
      dialog.current?.querySelector<HTMLInputElement>("input")?.focus();
    } catch (e) {
      if (current === generation.current) setError((e as Error).message);
    } finally {
      if (current === generation.current) setBusy(false);
    }
  }
  function filterPath(next: string) {
    setPath(next);
    clearTimeout(pendingFilter.current);
    const current = ++generation.current;
    setError("");
    if (composing.current) return;
    const slash = next.lastIndexOf("/");
    const parent =
      slash < 0 ? currentDirectory.current?.path : next.slice(0, slash) || "/";
    const leaf = next.slice(slash + 1);
    const sameDirectory =
      parent === currentDirectory.current?.path ||
      parent === currentDirectory.current?.requestedPath;
    setPrefix(leaf);
    if (sameDirectory) {
      setListing(currentDirectory.current);
      setBusy(false);
      return;
    }
    setListing(undefined);
    setBusy(true);
    pendingFilter.current = setTimeout(() => {
      void command("directory.list", parent ? { path: parent } : {})
        .then((result) => {
          if (generation.current !== current) return;
          currentDirectory.current = { ...result, requestedPath: parent };
          setListing(result);
        })
        .catch((e) => {
          if (generation.current === current) setError((e as Error).message);
        })
        .finally(() => {
          if (generation.current === current) setBusy(false);
        });
    }, 180);
  }
  const visibleEntries = (listing?.entries ?? []).filter(
    (entry: Data) =>
      (hidden || !entry.name.startsWith(".")) &&
      entry.name.toLocaleLowerCase().startsWith(prefix.toLocaleLowerCase()),
  );
  const trimmedPath = path.replace(/\/+$/, "");
  const lastSlash = trimmedPath.lastIndexOf("/");
  const createName = trimmedPath.slice(lastSlash + 1);
  const createParent = trimmedPath.slice(0, lastSlash) || "/";
  const currentPath = currentDirectory.current?.path;
  const canCreate =
    !busy &&
    !submitting &&
    !!createName &&
    createName !== "." &&
    createName !== ".." &&
    createParent === currentPath &&
    !currentDirectory.current?.entries?.some(
      (entry: Data) => entry.name === createName,
    );
  function completePath() {
    if (busy || !visibleEntries.length) return;
    if (visibleEntries.length === 1) {
      filterPath(visibleEntries[0].path.replace(/\/$/, "") + "/");
      return;
    }
    // Extend only the prefix shared by every match; never pick an arbitrary folder.
    let common = visibleEntries[0].name as string;
    for (const entry of visibleEntries.slice(1)) {
      while (
        !entry.name.toLocaleLowerCase().startsWith(common.toLocaleLowerCase())
      )
        common = common.slice(0, -1);
    }
    if (common.length > prefix.length) {
      filterPath(path.slice(0, path.lastIndexOf("/") + 1) + common);
    } else {
      dialog.current
        ?.querySelector<HTMLButtonElement>(".directory-list button")
        ?.focus();
    }
  }
  useEffect(() => {
    const prior = document.activeElement as HTMLElement;
    dialog.current?.querySelector<HTMLInputElement>("input")?.focus();
    void browse(project?.root);
    return () => {
      clearTimeout(pendingFilter.current);
      generation.current++;
      prior?.focus();
    };
  }, []);
  async function createFolder() {
    if (!canCreate) return;
    const current = ++generation.current;
    clearTimeout(pendingFilter.current);
    setBusy(true);
    setError("");
    try {
      const result = await command("directory.create", { path: trimmedPath });
      if (current !== generation.current) return;
      currentDirectory.current = { ...result, requestedPath: trimmedPath };
      setListing(result);
      setPath(result.path);
      setPrefix("");
    } catch (e) {
      if (current === generation.current) setError((e as Error).message);
    } finally {
      if (current === generation.current) setBusy(false);
    }
  }
  async function open() {
    if (!listing || busy) return;
    setSubmitting(true);
    setBusy(true);
    setError("");
    try {
      const result = await command(project ? "workspace.add" : "project.add", {
        directorySelectionId: listing.selectionId,
        ...(project ? { projectId: project.id } : {}),
      });
      await refresh();
      close();
      added?.(result);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
      setSubmitting(false);
    }
  }
  return (
    <div
      className="modal-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget && !submitting) close();
      }}
    >
      <div
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="modal directory-dialog"
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            if (!submitting) close();
          }
          if (e.key === "Tab") {
            const items = Array.from(
              dialog.current!.querySelectorAll<HTMLElement>(
                "button:not(:disabled),input:not(:disabled)",
              ),
            );
            const first = items[0],
              last = items.at(-1);
            if (e.shiftKey && document.activeElement === first) {
              e.preventDefault();
              last?.focus();
            } else if (!e.shiftKey && document.activeElement === last) {
              e.preventDefault();
              first?.focus();
            }
          }
        }}
      >
        <h2>{title}</h2>
        <p className="dialog-description">
          Choose a folder on this computer
          {project ? ` for ${project.label}` : ""}.
        </p>
        <form
          className="directory-location"
          onSubmit={(e) => {
            e.preventDefault();
            void browse(path);
          }}
        >
          <label>
            Folder path
            <input
              aria-label="Folder path"
              readOnly={submitting || (!currentDirectory.current && busy)}
              value={path}
              onChange={(e) => filterPath(e.target.value)}
              onCompositionStart={() => {
                composing.current = true;
              }}
              onCompositionEnd={(e) => {
                composing.current = false;
                filterPath(e.currentTarget.value);
              }}
              onKeyDown={(e) => {
                if (
                  e.key === "Tab" &&
                  !e.shiftKey &&
                  !e.ctrlKey &&
                  !e.metaKey &&
                  !e.altKey &&
                  !busy &&
                  visibleEntries.length > 0 &&
                  !e.nativeEvent.isComposing &&
                  !composing.current &&
                  !submitting &&
                  prefix
                ) {
                  e.preventDefault();
                  e.stopPropagation();
                  completePath();
                }
                if (e.key === "Enter" && e.nativeEvent.isComposing)
                  e.preventDefault();
                if (e.key === "ArrowDown" && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  dialog.current
                    ?.querySelector<HTMLButtonElement>(".directory-list button")
                    ?.focus();
                }
              }}
            />
          </label>
          <button type="submit" disabled={submitting}>
            Go
          </button>
        </form>
        <div className="directory-toolbar">
          <button disabled={busy} onClick={() => void browse()}>
            Home
          </button>
          <button
            disabled={busy || !listing || listing.parent === listing.path}
            onClick={() => void browse(listing?.parent)}
          >
            Up one folder
          </button>
        </div>
        {error && (
          <div className="directory-error" role="alert">
            <p>{error}</p>
            {canCreate && (
              <button onClick={() => void createFolder()}>
                Create folder “{createName}”
              </button>
            )}
          </div>
        )}
        <div className="directory-list" aria-label="Folders" aria-busy={busy}>
          {busy && <p>Loading…</p>}
          {!busy &&
            visibleEntries.map((entry: Data) => (
              <button
                key={entry.path}
                onClick={() => void browse(entry.path)}
                onKeyDown={(e) => {
                  if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
                  e.preventDefault();
                  const sibling =
                    e.key === "ArrowDown"
                      ? e.currentTarget.nextElementSibling
                      : e.currentTarget.previousElementSibling;
                  (sibling as HTMLButtonElement | null)?.focus();
                }}
              >
                <FolderIcon className="directory-folder-icon" />
                <span>{entry.name}</span>
                <span aria-hidden="true">›</span>
              </button>
            ))}
          {!busy && listing && visibleEntries.length === 0 && (
            <div className="directory-empty">
              <p>
                {prefix
                  ? "No matching folders."
                  : "No subfolders. You can open this folder."}
              </p>
              {canCreate && (
                <button onClick={() => void createFolder()}>
                  Create folder “{createName}”
                </button>
              )}
            </div>
          )}
        </div>
        {listing?.truncated && (
          <p className="dialog-description">
            Only part of this directory is shown. Enter a folder path to go
            directly to it.
          </p>
        )}
        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={hidden}
            onChange={(e) => setHidden(e.target.checked)}
          />
          Show hidden folders
        </label>
        <div className="directory-selection">
          Selected folder<strong>{listing?.path ?? "Choose a folder"}</strong>
        </div>
        <div className="actions">
          <button disabled={submitting} onClick={close}>
            Cancel
          </button>
          <button
            className="primary"
            disabled={
              busy ||
              !listing ||
              (path.replace(/\/$/, "") || "/") !== listing.path
            }
            onClick={() => void open()}
          >
            Open folder
          </button>
        </div>
      </div>
    </div>
  );
}
