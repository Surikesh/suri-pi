import type { ReactNode } from "react";

const PREFIX = "PI_SUBAGENT_ASYNC_JSON:";
const states = [
  "queued",
  "running",
  "complete",
  "failed",
  "partial",
  "paused",
  "stopped",
  "rejected",
] as const;
type State = (typeof states)[number];
type Node = {
  id: string;
  label: string;
  kind: string;
  state: State;
  activity?: { turnCount?: number; toolCount?: number; currentTool?: string };
  children?: Node[];
};
type Snapshot = { runs: Node[]; omittedRuns: number; omittedChildren: number };

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function count(value: unknown) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}
function node(value: unknown, depth = 0): Node | undefined {
  if (
    !record(value) ||
    typeof value.id !== "string" ||
    typeof value.label !== "string" ||
    typeof value.kind !== "string" ||
    !states.includes(value.state as State)
  )
    return;
  const activity = record(value.activity) ? value.activity : {};
  return {
    id: value.id.slice(0, 160),
    label: value.label.slice(0, 160),
    kind: value.kind,
    state: value.state as State,
    activity: {
      turnCount: count(activity.turnCount),
      toolCount: count(activity.toolCount),
      currentTool:
        typeof activity.currentTool === "string"
          ? activity.currentTool.slice(0, 160)
          : undefined,
    },
    children:
      depth < 3 && Array.isArray(value.children)
        ? value.children
            .slice(0, 8)
            .map((child) => node(child, depth + 1))
            .filter((child): child is Node => !!child)
        : undefined,
  };
}

/** Only the documented pi-subagents widget version is interpreted; never expose raw transport JSON. */
export function parseSubagentStatus(lines: unknown): Snapshot | undefined {
  if (
    !Array.isArray(lines) ||
    lines.length !== 1 ||
    typeof lines[0] !== "string" ||
    !lines[0].startsWith(PREFIX) ||
    lines[0].length > 50000
  )
    return;
  try {
    const value: unknown = JSON.parse(lines[0].slice(PREFIX.length));
    if (
      !record(value) ||
      value.kind !== "pi-subagents.async-status-snapshot" ||
      value.version !== 1 ||
      !Array.isArray(value.runs)
    )
      return;
    const omitted = record(value.omitted) ? value.omitted : {};
    return {
      runs: value.runs
        .slice(0, 20)
        .map((run) => node(run))
        .filter((run): run is Node => !!run),
      omittedRuns: count(omitted.runs) ?? 0,
      omittedChildren: count(omitted.children) ?? 0,
    };
  } catch {
    return;
  }
}

const labels: Record<State, string> = {
  queued: "Queued",
  running: "Running",
  complete: "Complete",
  failed: "Failed",
  partial: "Partial",
  paused: "Paused",
  stopped: "Stopped",
  rejected: "Rejected",
};

function activityText(activity: Node["activity"]) {
  if (!activity) return "";
  const parts: string[] = [];
  if (activity.currentTool) parts.push(`Tool: ${activity.currentTool}`);
  if (activity.turnCount !== undefined)
    parts.push(`${activity.turnCount} turns`);
  if (activity.toolCount !== undefined)
    parts.push(`${activity.toolCount} tools`);
  return parts.join(" · ");
}

function StatusNode({ item, depth }: { item: Node; depth: number }): ReactNode {
  return (
    <li className="subagent-row" style={{ paddingLeft: `${depth * 16}px` }}>
      <div className="subagent-line">
        <span className={`subagent-dot ${item.state}`} aria-hidden="true" />
        <span className="subagent-label">{item.label}</span>
        <span className={`subagent-state ${item.state}`}>
          {labels[item.state]}
        </span>
      </div>
      {activityText(item.activity) && (
        <div className="subagent-activity">{activityText(item.activity)}</div>
      )}
      {!!item.children?.length && (
        <ul className="subagent-list">
          {item.children.map((child) => (
            <StatusNode key={child.id} item={child} depth={depth + 1} />
          ))}
        </ul>
      )}
    </li>
  );
}

export function SubagentStatus({ lines }: { lines: unknown }) {
  if (!Array.isArray(lines) || lines.length === 0) return null;
  const snapshot = parseSubagentStatus(lines);
  if (!snapshot)
    return (
      <div className="subagent-status" role="note">
        Subagent status unavailable
      </div>
    );
  if (!snapshot.runs.length && !snapshot.omittedRuns) return null;
  const running = snapshot.runs.filter((run) => run.state === "running").length;
  return (
    <section className="subagent-status" aria-label="Subagent activity">
      <div className="subagent-heading">
        <strong>Subagents</strong>
        <span>
          {running
            ? `${running} running`
            : `${snapshot.runs.length} ${snapshot.runs.length === 1 ? "run" : "runs"}`}
        </span>
      </div>
      <ul className="subagent-list">
        {snapshot.runs.map((run) => (
          <StatusNode key={run.id} item={run} depth={0} />
        ))}
      </ul>
      {(snapshot.omittedRuns > 0 || snapshot.omittedChildren > 0) && (
        <p className="subagent-omitted">
          More activity not shown ({snapshot.omittedRuns} runs,{" "}
          {snapshot.omittedChildren} steps).
        </p>
      )}
    </section>
  );
}
