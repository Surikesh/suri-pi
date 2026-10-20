import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { command, report } from "../../store.js";
import {
  type Direction,
  type Group,
  type LayoutNode,
  type WorkspaceLayout,
  layoutKey,
  leafIds,
  legacyKey,
  loadLayout,
  makeGroup,
  makePane,
  removeLeaf,
  replaceLeaf,
  updateSplitRatio,
} from "./layout.js";
import { TerminalSession } from "./terminal-session.js";
import { TerminalBar } from "./group-tabs.js";

export default function TerminalPane({
  workspaceId,
  execution,
  onExecutionHandled,
}: {
  workspaceId: string;
  execution?: { id: string; command: string };
  onExecutionHandled?: (id: string) => void;
}) {
  const [layout, setLayout] = useState<WorkspaceLayout>(() =>
    loadLayout(workspaceId),
  );
  const [renameGroupId, setRenameGroupId] = useState<string>();
  const workspaceRef = useRef<HTMLElement>(null);
  const totalPanes = useMemo(
    () => layout.groups.reduce((count, group) => count + group.panes.length, 0),
    [layout.groups],
  );
  useEffect(() => {
    setLayout(loadLayout(workspaceId));
  }, [workspaceId]);
  useEffect(() => {
    sessionStorage.setItem(layoutKey(workspaceId), JSON.stringify(layout));
    sessionStorage.removeItem(legacyKey(workspaceId));
  }, [layout, workspaceId]);

  const updateTerminalId = useCallback((paneId: string, terminalId: string) => {
    setLayout((current) => ({
      ...current,
      groups: current.groups.map((group) => ({
        ...group,
        panes: group.panes.map((pane) =>
          pane.id === paneId ? { ...pane, terminalId } : pane,
        ),
      })),
    }));
  }, []);

  const newGroup = useCallback(() => {
    setLayout((current) => {
      if (
        current.groups.reduce(
          (count, group) => count + group.panes.length,
          0,
        ) >= 4
      )
        return current;
      const sequence = current.sequence + 1;
      const group = makeGroup(sequence);
      return {
        groups: [...current.groups, group],
        activeGroupId: group.id,
        sequence,
      };
    });
  }, []);

  const splitActive = useCallback((direction: Direction) => {
    setLayout((current) => {
      const total = current.groups.reduce(
        (count, group) => count + group.panes.length,
        0,
      );
      if (total >= 4) return current;
      const sequence = current.sequence + 1;
      return {
        ...current,
        sequence,
        groups: current.groups.map((group) => {
          if (group.id !== current.activeGroupId) return group;
          const pane = makePane(sequence);
          return {
            ...group,
            panes: [...group.panes, pane],
            activePaneId: pane.id,
            root: replaceLeaf(group.root, group.activePaneId, {
              kind: "split",
              id: crypto.randomUUID(),
              direction,
              ratio: 0.5,
              first: { kind: "pane", paneId: group.activePaneId },
              second: { kind: "pane", paneId: pane.id },
            }),
          };
        }),
      };
    });
  }, []);

  const closePane = useCallback((groupId: string, paneId: string) => {
    setLayout((current) => {
      const group = current.groups.find(
        (candidate) => candidate.id === groupId,
      );
      const pane = group?.panes.find((candidate) => candidate.id === paneId);
      if (pane?.terminalId)
        void command("terminal.close", { terminalId: pane.terminalId }).catch(
          report,
        );
      if (!group || group.panes.length === 1) {
        if (current.groups.length === 1) {
          const replacement = makeGroup(current.sequence + 1);
          return {
            groups: [replacement],
            activeGroupId: replacement.id,
            sequence: current.sequence + 1,
          };
        }
        const groups = current.groups.filter(
          (candidate) => candidate.id !== groupId,
        );
        return {
          ...current,
          groups,
          activeGroupId:
            current.activeGroupId === groupId
              ? groups[groups.length - 1].id
              : current.activeGroupId,
        };
      }
      const root = removeLeaf(group.root, paneId)!;
      const ids = leafIds(root);
      return {
        ...current,
        groups: current.groups.map((candidate) =>
          candidate.id === groupId
            ? {
                ...candidate,
                root,
                panes: candidate.panes.filter((item) => item.id !== paneId),
                activePaneId: ids.includes(candidate.activePaneId)
                  ? candidate.activePaneId
                  : ids[0],
              }
            : candidate,
        ),
      };
    });
  }, []);

  const renderNode = (group: Group, node: LayoutNode): React.ReactNode => {
    if (node.kind === "split")
      return (
        <div className={`terminal-split terminal-split-${node.direction}`}>
          <div
            className="terminal-split-child"
            style={{ flexBasis: `${node.ratio * 100}%` }}
          >
            {renderNode(group, node.first)}
          </div>
          <div
            className="terminal-split-divider"
            role="separator"
            aria-label="Resize terminal panes"
            aria-orientation={
              node.direction === "row" ? "vertical" : "horizontal"
            }
            tabIndex={0}
            onPointerDown={(event) =>
              event.currentTarget.setPointerCapture(event.pointerId)
            }
            onPointerMove={(event) => {
              if (!event.currentTarget.hasPointerCapture(event.pointerId))
                return;
              const parent =
                event.currentTarget.parentElement!.getBoundingClientRect();
              const position =
                node.direction === "row"
                  ? (event.clientX - parent.left) / parent.width
                  : (event.clientY - parent.top) / parent.height;
              const ratio = Math.max(0.2, Math.min(0.8, position));
              setLayout((current) => ({
                ...current,
                groups: current.groups.map((candidate) =>
                  candidate.id === group.id
                    ? {
                        ...candidate,
                        root: updateSplitRatio(candidate.root, node.id, ratio),
                      }
                    : candidate,
                ),
              }));
            }}
            onKeyDown={(event) => {
              const decrease =
                (node.direction === "row" && event.key === "ArrowLeft") ||
                (node.direction === "column" && event.key === "ArrowUp");
              const increase =
                (node.direction === "row" && event.key === "ArrowRight") ||
                (node.direction === "column" && event.key === "ArrowDown");
              if (!decrease && !increase) return;
              event.preventDefault();
              const ratio = Math.max(
                0.2,
                Math.min(0.8, node.ratio + (decrease ? -0.05 : 0.05)),
              );
              setLayout((current) => ({
                ...current,
                groups: current.groups.map((candidate) =>
                  candidate.id === group.id
                    ? {
                        ...candidate,
                        root: updateSplitRatio(candidate.root, node.id, ratio),
                      }
                    : candidate,
                ),
              }));
            }}
          />
          <div className="terminal-split-child">
            {renderNode(group, node.second)}
          </div>
        </div>
      );
    const pane = group.panes.find((candidate) => candidate.id === node.paneId);
    if (!pane) return null;
    const isActive =
      group.id === layout.activeGroupId && pane.id === group.activePaneId;
    return (
      <TerminalSession
        key={pane.id}
        workspaceId={workspaceId}
        pane={pane}
        active={isActive}
        execution={isActive ? execution : undefined}
        onReady={updateTerminalId}
        onActivate={() =>
          setLayout((current) => ({
            ...current,
            activeGroupId: group.id,
            groups: current.groups.map((candidate) =>
              candidate.id === group.id
                ? { ...candidate, activePaneId: pane.id }
                : candidate,
            ),
          }))
        }
        onExecutionHandled={onExecutionHandled}
      />
    );
  };

  return (
    <section
      ref={workspaceRef}
      className="terminal-workspace terminal-pane"
      aria-label="Workspace terminal"
      onKeyDown={(event) => {
        if (!(event.metaKey || event.ctrlKey) || !event.shiftKey) return;
        if (event.code === "KeyT") {
          event.preventDefault();
          newGroup();
        }
        if (event.code === "KeyD") {
          event.preventDefault();
          splitActive(event.altKey ? "column" : "row");
        }
      }}
    >
      <TerminalBar
        layout={layout}
        setLayout={setLayout}
        renameGroupId={renameGroupId}
        setRenameGroupId={setRenameGroupId}
        totalPanes={totalPanes}
        newGroup={newGroup}
        splitActive={splitActive}
        closePane={closePane}
      />
      <div className="terminal-groups">
        {layout.groups.map((group) => (
          <div
            key={group.id}
            className="terminal-group"
            role="tabpanel"
            hidden={group.id !== layout.activeGroupId}
          >
            {renderNode(group, group.root)}
          </div>
        ))}
      </div>
    </section>
  );
}
