export type Direction = "row" | "column";
export type LayoutNode =
  | { kind: "pane"; paneId: string }
  | {
      kind: "split";
      id: string;
      direction: Direction;
      ratio: number;
      first: LayoutNode;
      second: LayoutNode;
    };
export type Pane = { id: string; title: string; terminalId?: string };
export type Group = {
  id: string;
  title: string;
  root: LayoutNode;
  panes: Pane[];
  activePaneId: string;
};
export type WorkspaceLayout = {
  groups: Group[];
  activeGroupId: string;
  sequence: number;
};

export const layoutKey = (workspaceId: string) =>
  `suri.terminal-workspace.${workspaceId}`;
export const legacyKey = (workspaceId: string) =>
  `suri.terminal.${workspaceId}`;
export const makePane = (_sequence: number, terminalId?: string): Pane => ({
  id: crypto.randomUUID(),
  title: "zsh",
  terminalId,
});
export const makeGroup = (sequence: number, terminalId?: string): Group => {
  const pane = makePane(sequence, terminalId);
  return {
    id: crypto.randomUUID(),
    title: pane.title,
    root: { kind: "pane", paneId: pane.id },
    panes: [pane],
    activePaneId: pane.id,
  };
};
const initialLayout = (workspaceId: string): WorkspaceLayout => {
  const terminalId =
    sessionStorage.getItem(legacyKey(workspaceId)) ?? undefined;
  const group = makeGroup(1, terminalId);
  return { groups: [group], activeGroupId: group.id, sequence: 1 };
};
export const loadLayout = (workspaceId: string): WorkspaceLayout => {
  try {
    const parsed = JSON.parse(
      sessionStorage.getItem(layoutKey(workspaceId)) ?? "null",
    );
    if (parsed?.groups?.length && parsed.activeGroupId)
      return {
        ...parsed,
        groups: parsed.groups.map((group: Group) => ({
          ...group,
          title: /^zsh \d+$/.test(group.title) ? "zsh" : group.title,
          panes: group.panes.map((pane) => ({
            ...pane,
            title: /^zsh \d+$/.test(pane.title) ? "zsh" : pane.title,
          })),
        })),
      };
  } catch {
    // Invalid view state is disposable; live terminal ids remain host-owned.
  }
  return initialLayout(workspaceId);
};
export const replaceLeaf = (
  node: LayoutNode,
  paneId: string,
  replacement: LayoutNode,
): LayoutNode => {
  if (node.kind === "pane") return node.paneId === paneId ? replacement : node;
  return {
    ...node,
    first: replaceLeaf(node.first, paneId, replacement),
    second: replaceLeaf(node.second, paneId, replacement),
  };
};
export const updateSplitRatio = (
  node: LayoutNode,
  splitId: string,
  ratio: number,
): LayoutNode => {
  if (node.kind === "pane") return node;
  if (node.id === splitId) return { ...node, ratio };
  return {
    ...node,
    first: updateSplitRatio(node.first, splitId, ratio),
    second: updateSplitRatio(node.second, splitId, ratio),
  };
};
export const removeLeaf = (
  node: LayoutNode,
  paneId: string,
): LayoutNode | undefined => {
  if (node.kind === "pane") return node.paneId === paneId ? undefined : node;
  const first = removeLeaf(node.first, paneId);
  const second = removeLeaf(node.second, paneId);
  if (!first) return second;
  if (!second) return first;
  return { ...node, first, second };
};
export const leafIds = (node: LayoutNode): string[] =>
  node.kind === "pane"
    ? [node.paneId]
    : [...leafIds(node.first), ...leafIds(node.second)];
