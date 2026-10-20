import React, { useEffect, useRef, useState } from "react";
import type { ThemedToken } from "shiki/core";
import { command } from "../../store.js";
import { accessibleColor, highlightCode, languageForPath } from "../../code.js";
import type { Data } from "../../../../../packages/protocol/src/index.js";
import { copyText, saveFile } from "./clipboard.js";
import { HighlightedTextarea } from "./highlighted-textarea.js";
import { FileContent } from "./file-content.js";
import { fileType } from "./file-type-icon.js";

export function LinkedFilePreview({
  workspaceId,
  path,
  line,
  close,
}: {
  workspaceId?: string;
  path: string;
  line?: number;
  close: () => void;
}) {
  const [file, setFile] = useState<Data>();
  const [error, setError] = useState("");
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState("");
  const [highlighted, setHighlighted] = useState<
    { path: string; content: string; lines: ThemedToken[][] } | undefined
  >();
  const ref = useRef<HTMLDivElement>(null);
  const editor = useRef<HTMLTextAreaElement>(null);
  const editable = Boolean(
    workspaceId && file?.encoding === "utf8" && !file.truncated,
  );
  const dirty = Boolean(editable && draft !== file?.content);
  const displayContent = editing ? draft : (file?.content ?? "");
  useEffect(() => {
    const prior = document.activeElement as HTMLElement;
    ref.current?.querySelector<HTMLButtonElement>("button")?.focus();
    let live = true;
    void command(workspaceId ? "file.read" : "externalFile.read", {
      ...(workspaceId ? { workspaceId, path } : { path, confirmed: true }),
    })
      .then((f) => {
        if (live) {
          setFile(f);
          if (f.encoding === "utf8") setDraft(f.content);
        }
      })
      .catch((e) => {
        if (live) setError(e.message);
      });
    return () => {
      live = false;
      prior?.focus();
    };
  }, [workspaceId, path]);
  useEffect(() => {
    if (editing) editor.current?.focus();
  }, [editing]);
  useEffect(() => {
    let active = true;
    if (
      file?.encoding !== "utf8" ||
      file.truncated ||
      displayContent.length >= 100000
    ) {
      setHighlighted(undefined);
      return;
    }
    const timer = window.setTimeout(
      () => {
        // Highlighting is an enhancement; on failure the plain text stays shown.
        void languageForPath(path)
          .then((language) =>
            language ? highlightCode(displayContent, language) : undefined,
          )
          .then((lines) => {
            if (active && lines)
              setHighlighted({ path, content: displayContent, lines });
          })
          .catch(() => {});
      },
      editing ? 80 : 0,
    );
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [displayContent, editing, file?.encoding, file?.truncated, path]);
  useEffect(() => {
    if (file && line)
      ref.current
        ?.querySelector(`[data-line="${line}"]`)
        ?.scrollIntoView({ block: "center" });
  }, [file, line]);
  const guardClose = () => {
    if (dirty) {
      setStatus("Save or cancel your changes before closing.");
      return;
    }
    close();
  };
  const save = async () => {
    if (!file || !editable || saving) return;
    setSaving(true);
    setStatus("Saving…");
    try {
      const next = await command("file.write", {
        workspaceId,
        path,
        content: draft,
        expectedRevision: file.revision,
      });
      setFile(next);
      setDraft(next.content);
      setEditing(false);
      setStatus("Saved to the workspace file.");
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };
  const act = async (type: "open" | "openWith" | "reveal") => {
    setStatus(type === "reveal" ? "Opening Finder…" : "Opening…");
    try {
      await command(workspaceId ? `file.${type}` : `externalFile.${type}`, {
        ...(workspaceId ? { workspaceId, path } : { path, confirmed: true }),
      });
      setStatus(
        type === "openWith"
          ? "Choose an application in the macOS dialog."
          : type === "reveal"
            ? "Revealed in Finder."
            : "Opened in the default application.",
      );
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <div
      className="modal-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) guardClose();
      }}
    >
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={`Preview ${path}`}
        className="modal linked-file-preview"
        onKeyDown={(e) => {
          if (editing && e.key.toLowerCase() === "s" && e.metaKey) {
            e.preventDefault();
            void save();
            return;
          }
          if (e.key === "Escape") {
            e.stopPropagation();
            if (editing && !dirty) setEditing(false);
            else guardClose();
          }
          if (e.key === "Tab") {
            const items = Array.from(
              ref.current!.querySelectorAll<HTMLElement>(
                "button:not(:disabled), textarea:not(:disabled)",
              ),
            );
            e.preventDefault();
            const i = items.indexOf(document.activeElement as HTMLElement);
            items[
              (i + (e.shiftKey ? -1 : 1) + items.length) % items.length
            ]?.focus();
          }
        }}
      >
        <header className="linked-file-header">
          <div>
            <h2>
              {path}
              {line ? `:${line}` : ""}
            </h2>
            <p className="linked-file-status" aria-live="polite">
              {status || (editing ? "Editing workspace file" : "Preview")}
            </p>
          </div>
          <button onClick={guardClose}>Close</button>
        </header>
        {error && (
          <p className="linked-file-error" role="alert">
            {error}
          </p>
        )}
        {file ? (
          <>
            <div className="linked-file-toolbar">
              <div>
                {!editing ? (
                  <button
                    className="primary"
                    disabled={!editable}
                    onClick={() => {
                      setStatus("");
                      setEditing(true);
                    }}
                  >
                    Edit
                  </button>
                ) : (
                  <>
                    <button
                      className="primary"
                      disabled={!dirty || saving}
                      onClick={() => void save()}
                    >
                      {saving ? "Saving…" : "Save"}
                    </button>
                    <button
                      disabled={saving}
                      onClick={() => {
                        setDraft(file.content);
                        setEditing(false);
                        setStatus("Edits discarded.");
                      }}
                    >
                      Cancel
                    </button>
                  </>
                )}
                <button
                  disabled={file.encoding !== "utf8"}
                  onClick={() =>
                    void copyText(draft)
                      .then(() => setStatus("Copied to the clipboard."))
                      .catch(() => setStatus("Could not copy the text."))
                  }
                >
                  Copy
                </button>
                <button
                  disabled={file.truncated}
                  onClick={() =>
                    saveFile(editing ? { ...file, content: draft } : file, path)
                  }
                >
                  Save a Copy
                </button>
              </div>
              <div>
                <button onClick={() => void act("open")}>Open</button>
                <button onClick={() => void act("openWith")}>Open With…</button>
                <button onClick={() => void act("reveal")}>
                  Reveal in Finder
                </button>
              </div>
            </div>
            {file.truncated && (
              <p className="linked-file-error">
                Preview truncated at 1 MiB; editing and download are
                unavailable.
              </p>
            )}
            <div className="linked-file-body">
              {editing ? (
                fileType(path).kind === "markdown" ? (
                  <div className="markdown-live-editor">
                    <FileContent text={draft} path={path} />
                    <HighlightedTextarea
                      path={path}
                      value={draft}
                      onChange={setDraft}
                      textareaRef={editor}
                    />
                  </div>
                ) : (
                  <HighlightedTextarea
                    path={path}
                    value={draft}
                    onChange={setDraft}
                    textareaRef={editor}
                  />
                )
              ) : fileType(path).kind === "markdown" ? (
                <FileContent text={file.content} path={path} line={line} />
              ) : (
                <pre onDoubleClick={() => editable && setEditing(true)}>
                  {file.encoding === "utf8"
                    ? file.content
                        .split("\n")
                        .map((text: string, index: number) => (
                          <span
                            className={
                              index + 1 === line
                                ? "file-line selected"
                                : "file-line"
                            }
                            data-line={index + 1}
                            key={index}
                          >
                            {highlighted?.path === path &&
                            highlighted.content === file.content &&
                            highlighted.lines[index]?.length
                              ? highlighted.lines[index].map(
                                  (token: ThemedToken, tokenIndex: number) => (
                                    <span
                                      key={tokenIndex}
                                      style={{
                                        color: accessibleColor(token.color),
                                      }}
                                    >
                                      {token.content}
                                    </span>
                                  ),
                                )
                              : text}
                            {"\n"}
                          </span>
                        ))
                    : "Binary file · use Save a Copy"}
                </pre>
              )}
            </div>
          </>
        ) : (
          !error && <p>Loading…</p>
        )}
      </div>
    </div>
  );
}
