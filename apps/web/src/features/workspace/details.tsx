import React, { useEffect, useRef, useState } from "react";
import type { Data } from "../../../../../packages/protocol/src/index.js";
import { FileBrowser } from "./file-browser.js";
import { ChangesPane } from "./changes-pane.js";
import { isEditingTarget } from "./details-helpers.js";
import { useChanges } from "./use-changes.js";
import { useDetailsWidth } from "./use-details-width.js";

const TerminalPane = React.lazy(() => import("../../terminal.js"));
export default function Details({
  workspace,
  close,
  execution,
  onExecutionHandled,
  width: controlledWidth,
  onWidthChange,
  requestedChange,
  requestedFile,
  transientChange,
  onPreviewEnter,
  onPreviewLeave,
  onPinChange,
  onDismissPreview,
}: {
  workspace: Data;
  close: () => void;
  execution?: { id: string; workspaceId: string; command: string };
  onExecutionHandled?: (id: string) => void;
  width?: number;
  onWidthChange?: (width: number, persist: boolean) => void;
  requestedChange?: { path: string; requestId: number };
  requestedFile?: { path: string; requestId: number };
  transientChange?: string;
  onPreviewEnter?: () => void;
  onPreviewLeave?: () => void;
  onPinChange?: (path: string) => void;
  onDismissPreview?: () => void;
}) {
  const aside = useRef<HTMLElement>(null);
  const { minWidth, maxWidth, width, resize, resizeStart } = useDetailsWidth({
    controlledWidth,
    onWidthChange,
    aside,
  });
  const [expanded, setExpanded] = useState(false);
  const expandButton = useRef<HTMLButtonElement>(null);
  const restoreExpandedFocus = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.defaultPrevented || isEditingTarget(event.target)) return;
      if (
        (event.metaKey || event.ctrlKey) &&
        event.shiftKey &&
        !event.altKey &&
        (event.code === "KeyE" || event.key.toLowerCase() === "e")
      ) {
        event.preventDefault();
        if (!expanded)
          restoreExpandedFocus.current =
            document.activeElement instanceof HTMLElement
              ? document.activeElement
              : null;
        setExpanded((value) => !value);
      }
      if (
        event.key === "Escape" &&
        expanded &&
        aside.current?.contains(event.target as Node)
      ) {
        event.preventDefault();
        setExpanded(false);
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [expanded]);
  useEffect(() => {
    if (!expanded || !aside.current) return;
    const siblings = Array.from(aside.current.parentElement!.children).filter(
      (element) =>
        element !== aside.current &&
        element.matches("main, .sidebar, .sidebar-resizer, .scrim"),
    ) as HTMLElement[];
    const previousFocus =
      restoreExpandedFocus.current ??
      (document.activeElement as HTMLElement | null);
    restoreExpandedFocus.current = null;
    const previous = siblings.map((element) => element.inert);
    expandButton.current?.focus();
    siblings.forEach((element) => {
      element.inert = true;
    });
    return () => {
      siblings.forEach((element, index) => {
        element.inert = previous[index];
      });
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, [expanded]);
  const workspaceId = workspace.id;
  const [pinnedTab, setTabState] = useState(
    sessionStorage.getItem(`suri.detailTab.${workspaceId}`) ?? "Files",
  );
  const tab = transientChange ? "Changes" : pinnedTab;
  const setTab = (value: string) => {
    setTabState(value);
    sessionStorage.setItem(`suri.detailTab.${workspaceId}`, value);
  };
  useEffect(() => {
    if (execution?.workspaceId === workspaceId) setTab("Terminal");
  }, [execution?.id, execution?.workspaceId, workspaceId]);
  const changes = useChanges({
    workspaceId,
    workspaceRoot: workspace.root,
    tab,
    setTab,
    transientChange,
    requestedChange,
    requestedFile,
  });
  return (
    <aside
      ref={aside}
      onPointerEnter={onPreviewEnter}
      onPointerLeave={onPreviewLeave}
      onFocusCapture={onPreviewEnter}
      onBlurCapture={onPreviewLeave}
      className={`details workspace-details${expanded ? " expanded" : ""}`}
      style={{ width: expanded ? undefined : `min(${width}px, 100vw)` }}
      aria-label="Workspace details"
    >
      {!expanded && (
        <div
          className="details-resizer"
          role="separator"
          aria-label="Resize workspace details"
          aria-orientation="vertical"
          aria-valuemin={minWidth}
          aria-valuemax={maxWidth}
          aria-valuenow={width}
          tabIndex={0}
          onPointerDown={(event) => {
            resizeStart.current = { x: event.clientX, width };
            event.currentTarget.setPointerCapture(event.pointerId);
            event.preventDefault();
          }}
          onPointerMove={(event) => {
            if (resizeStart.current)
              resize(
                resizeStart.current.width +
                  resizeStart.current.x -
                  event.clientX,
                false,
              );
          }}
          onPointerUp={(event) => {
            if (resizeStart.current)
              resize(
                resizeStart.current.width +
                  resizeStart.current.x -
                  event.clientX,
                true,
              );
            resizeStart.current = undefined;
          }}
          onPointerCancel={() => {
            resizeStart.current = undefined;
          }}
          onKeyDown={(event) => {
            if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
              event.preventDefault();
              resize(width + (event.key === "ArrowLeft" ? 24 : -24), true);
            }
          }}
        />
      )}
      <div className="detail-top">
        <div role="tablist">
          {["Files", "Changes", "Terminal"].map((t) => (
            <button
              key={t}
              role="tab"
              aria-selected={tab === t}
              onClick={() => {
                onDismissPreview?.();
                setTab(t);
              }}
            >
              {t}
            </button>
          ))}
        </div>
        <button
          ref={expandButton}
          aria-label={expanded ? "Restore details size" : "Expand details"}
          title={`${expanded ? "Restore details size" : "Expand details"} (Ctrl/⌘ Shift E)`}
          aria-pressed={expanded}
          onClick={() => {
            if (!expanded)
              restoreExpandedFocus.current =
                document.activeElement instanceof HTMLElement
                  ? document.activeElement
                  : null;
            setExpanded((value) => !value);
          }}
        >
          {expanded ? "↙" : "↗"}
        </button>
        <button aria-label="Close details" onClick={close}>
          <span aria-hidden="true">×</span>
        </button>
      </div>
      {pinnedTab === "Terminal" && (
        <div className="preserved-pane" hidden={tab !== "Terminal"}>
          <React.Suspense fallback={<p>Opening terminal…</p>}>
            <TerminalPane
              workspaceId={workspaceId}
              execution={
                execution?.workspaceId === workspaceId ? execution : undefined
              }
              onExecutionHandled={onExecutionHandled}
            />
          </React.Suspense>
        </div>
      )}
      {tab !== "Terminal" && (
        <div className="detail-body">
          {pinnedTab === "Files" && (
            <div className="preserved-pane" hidden={tab !== "Files"}>
              <FileBrowser
                workspaceId={workspaceId}
                workspaceRoot={workspace.root}
                requestedFile={requestedFile}
              />
            </div>
          )}
          <ChangesPane
            tab={tab}
            transientChange={transientChange}
            onPinChange={onPinChange}
            workspaceId={workspaceId}
            changes={changes}
          />
        </div>
      )}
    </aside>
  );
}
