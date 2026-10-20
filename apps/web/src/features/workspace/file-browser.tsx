import React, { useEffect, useRef, useState } from "react";
import type { Data } from "../../../../../packages/protocol/src/index.js";
import { serviceNames } from "../../domain/presentation.js";
import { command, report } from "../../store.js";
import {
  FileContent,
  FileTypeIcon,
  HighlightedTextarea,
  saveFile,
} from "../../file-preview.js";

export const FileBrowser = React.memo(function FileBrowser({
  workspaceId,
  workspaceRoot,
  requestedFile,
}: {
  workspaceId: string;
  workspaceRoot: string;
  requestedFile?: { path: string; requestId: number };
}) {
  const previewRequest = useRef(0);
  const [nodes, setNodes] = useState<
    Record<string, { entries: Data[]; cursor?: string; error?: string }>
  >({});
  const [expanded, setExpanded] = useState(new Set<string>(["."]));
  const [showHidden, setShowHidden] = useState(false);
  const [preview, setPreview] = useState<
    { path: string; text?: string; error?: string; file?: Data } | undefined
  >();
  const [editingFile, setEditingFile] = useState(false);
  const [fileDraft, setFileDraft] = useState("");
  const [fileSaving, setFileSaving] = useState(false);
  const [fileStatus, setFileStatus] = useState("");
  const load = async (path: string, cursor?: string) => {
    try {
      const result = await command("file.list", {
        workspaceId,
        path,
        ...(cursor ? { cursor } : {}),
      });
      setNodes((old) => ({
        ...old,
        [path]: {
          entries: [
            ...(cursor ? (old[path]?.entries ?? []) : []),
            ...result.entries,
          ]
            .filter(
              (entry, index, all) =>
                all.findIndex((candidate) => candidate.name === entry.name) ===
                index,
            )
            .sort(
              (a, b) =>
                Number(b.kind === "directory") -
                  Number(a.kind === "directory") ||
                a.name.localeCompare(b.name, undefined, {
                  numeric: true,
                  sensitivity: "base",
                }),
            ),
          cursor: result.cursor,
        },
      }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setNodes((old) => ({
        ...old,
        [path]: { entries: old[path]?.entries ?? [], error: message },
      }));
    }
  };
  useEffect(() => {
    previewRequest.current++;
    setNodes({});
    setExpanded(new Set(["."]));
    setPreview(undefined);
    setEditingFile(false);
    setFileDraft("");
    setFileStatus("");
    void load(".");
  }, [workspaceId]);
  useEffect(() => {
    if (!requestedFile) return;
    const request = ++previewRequest.current;
    setEditingFile(false);
    setFileDraft("");
    setFileStatus("");
    setPreview({ path: requestedFile.path });
    void command("file.read", { workspaceId, path: requestedFile.path })
      .then((result) => {
        if (request !== previewRequest.current) return;
        const text =
          result.encoding === "utf8"
            ? result.content
            : "Binary file · preview unavailable";
        setPreview({ path: requestedFile.path, file: result, text });
        if (result.encoding === "utf8") setFileDraft(result.content);
      })
      .catch((error) => {
        if (request === previewRequest.current)
          setPreview({
            path: requestedFile.path,
            error: error instanceof Error ? error.message : String(error),
          });
      });
  }, [requestedFile?.requestId, workspaceId]);
  const visible = (entry: Data) =>
    showHidden ||
    (!entry.name.startsWith(".") && !serviceNames.has(entry.name));
  const branch = (path: string, depth: number): React.ReactNode => {
    const node = nodes[path];
    if (!node) return <p className="file-state">Loading…</p>;
    if (node.error)
      return (
        <p className="file-state error" role="alert">
          {node.error}
        </p>
      );
    const entries = node.entries.filter(visible);
    return (
      <>
        {entries.length === 0 && (
          <p className="file-state">This folder is empty.</p>
        )}
        {entries.map((entry) => {
          const next = path === "." ? entry.name : `${path}/${entry.name}`;
          const directory = entry.kind === "directory";
          const open = expanded.has(next);
          return (
            <React.Fragment key={next}>
              <button
                className={`file${preview?.path === next ? " selected" : ""}`}
                role="treeitem"
                aria-selected={preview?.path === next}
                style={{ paddingLeft: 7 + depth * 16 }}
                disabled={entry.kind === "symlink"}
                aria-expanded={directory ? open : undefined}
                title={next}
                onClick={() => {
                  if (directory) {
                    setExpanded((old) => {
                      const changed = new Set(old);
                      if (changed.has(next)) changed.delete(next);
                      else changed.add(next);
                      return changed;
                    });
                    if (!nodes[next]) void load(next);
                  } else {
                    const request = ++previewRequest.current;
                    setPreview({ path: next });
                    setEditingFile(false);
                    setFileDraft("");
                    setFileStatus("");
                    void command("file.read", { workspaceId, path: next })
                      .then((result) => {
                        if (request !== previewRequest.current) return;
                        const text =
                          result.encoding === "utf8"
                            ? result.content
                            : "Binary file · preview unavailable";
                        setPreview({ path: next, file: result, text });
                        if (result.encoding === "utf8")
                          setFileDraft(result.content);
                      })
                      .catch(
                        (error) =>
                          request === previewRequest.current &&
                          setPreview({
                            path: next,
                            error:
                              error instanceof Error
                                ? error.message
                                : String(error),
                          }),
                      );
                  }
                }}
              >
                <span className="file-chevron">
                  {directory ? (open ? "▾" : "▸") : ""}
                </span>
                <FileTypeIcon path={entry.name} directory={directory} />
                <span>{entry.name}</span>
                {entry.kind === "symlink" && (
                  <span aria-label="Symbolic link">↗</span>
                )}
              </button>
              {directory && open && (
                <div role="group" aria-label={entry.name}>
                  {branch(next, depth + 1)}
                </div>
              )}
            </React.Fragment>
          );
        })}
        {node.cursor && (
          <button
            className="file-more"
            onClick={() => void load(path, node.cursor)}
          >
            Load more
          </button>
        )}
      </>
    );
  };
  return (
    <div className={`file-browser${preview ? " has-preview" : ""}`}>
      <div className="file-navigation">
        <label className="file-toggle">
          <input
            type="checkbox"
            checked={showHidden}
            onChange={(event) => setShowHidden(event.target.checked)}
          />
          Show hidden and generated items
        </label>
        <div
          className="file-tree"
          role="tree"
          aria-label="Workspace files"
          onKeyDown={(event) => {
            const target = event.target as HTMLButtonElement;
            if (target.getAttribute("role") !== "treeitem") return;
            const items = Array.from(
              event.currentTarget.querySelectorAll<HTMLButtonElement>(
                '[role="treeitem"]:not(:disabled)',
              ),
            );
            const index = items.indexOf(target);
            let next: HTMLButtonElement | undefined;
            if (event.key === "ArrowDown") next = items[index + 1];
            else if (event.key === "ArrowUp") next = items[index - 1];
            else if (event.key === "Home") next = items[0];
            else if (event.key === "End") next = items.at(-1);
            else if (event.key === "ArrowRight") {
              if (target.getAttribute("aria-expanded") === "false")
                target.click();
              else if (target.getAttribute("aria-expanded") === "true")
                next = items[index + 1];
            } else if (event.key === "ArrowLeft") {
              if (target.getAttribute("aria-expanded") === "true")
                target.click();
              else {
                const parent = target.title.split("/").slice(0, -1).join("/");
                next = items.find((item) => item.title === parent);
              }
            } else return;
            event.preventDefault();
            next?.focus();
          }}
        >
          {branch(".", 0)}
        </div>
      </div>
      {preview && (
        <section
          className="file-preview"
          aria-label={`Preview ${preview.path}`}
        >
          <div className="file-preview-header">
            <strong>{preview.path}</strong>
            <div>
              {preview.file?.encoding === "utf8" &&
                !preview.file.truncated &&
                (!editingFile ? (
                  <button
                    onClick={() => {
                      setFileStatus("");
                      setEditingFile(true);
                    }}
                  >
                    Edit
                  </button>
                ) : (
                  <>
                    <button
                      data-save-file
                      disabled={fileSaving || fileDraft === preview.text}
                      onClick={() => {
                        setFileSaving(true);
                        setFileStatus("Saving…");
                        void command("file.write", {
                          workspaceId,
                          path: preview.path,
                          content: fileDraft,
                          expectedRevision: preview.file?.revision,
                        })
                          .then((file) => {
                            setPreview({
                              path: preview.path,
                              file,
                              text: file.content,
                            });
                            setFileDraft(file.content);
                            setEditingFile(false);
                            setFileStatus("Saved.");
                          })
                          .catch((error) =>
                            setFileStatus(
                              error instanceof Error
                                ? error.message
                                : String(error),
                            ),
                          )
                          .finally(() => setFileSaving(false));
                      }}
                    >
                      {fileSaving ? "Saving…" : "Save"}
                    </button>
                    <button
                      disabled={fileSaving}
                      onClick={() => {
                        setFileDraft(preview.text ?? "");
                        setEditingFile(false);
                        setFileStatus("");
                      }}
                    >
                      Cancel
                    </button>
                  </>
                ))}
              <button
                disabled={!preview.file || preview.file.truncated}
                onClick={() =>
                  preview.file && saveFile(preview.file, preview.path)
                }
              >
                Save a Copy
              </button>
              {[
                ["file.openWith", "Open With…"],
                ["file.reveal", "Reveal"],
              ].map(([type, label]) => (
                <button
                  key={type}
                  title={label}
                  onClick={() =>
                    void command(type, {
                      workspaceId,
                      path: preview.path,
                    }).catch(report)
                  }
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
          {fileStatus && (
            <p className="file-edit-status" role="status">
              {fileStatus}
            </p>
          )}
          {preview.error ? (
            <p role="alert">{preview.error}</p>
          ) : preview.text === undefined ? (
            <p>Loading…</p>
          ) : editingFile ? (
            <HighlightedTextarea
              path={preview.path}
              value={fileDraft}
              onChange={setFileDraft}
              onKeyDown={(event) => {
                if (
                  (event.metaKey || event.ctrlKey) &&
                  event.key.toLowerCase() === "s"
                ) {
                  event.preventDefault();
                  event.currentTarget
                    .closest(".file-preview")
                    ?.querySelector<HTMLButtonElement>("button[data-save-file]")
                    ?.click();
                }
              }}
            />
          ) : (
            <FileContent
              key={preview.path}
              text={preview.text}
              path={preview.path}
              workspaceRoot={workspaceRoot}
            />
          )}
        </section>
      )}
    </div>
  );
});
