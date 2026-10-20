import React from "react";
import {
  activePhases,
  type Block,
  type Data,
} from "../../../../../packages/protocol/src/index.js";
import { ArtifactPreview } from "./artifact-preview.js";
import { Disclosure, Icon } from "../../components/ui.js";
import { ActivityIcon } from "../../icons.js";
import {
  activityBlocksLabel,
  blockEntries,
  phaseLabel,
  shortSummary,
  toolIcon,
  toolLabel,
  toolSummary,
  type BlockEntry,
} from "../../domain/presentation.js";

const LazyRich = React.lazy(() => import("../../rich.js"));
function Rich({
  text,
  workspaceRoot,
  onExecute,
}: {
  text: string;
  workspaceRoot?: string;
  onExecute?: (command: string) => void;
}) {
  return (
    <React.Suspense
      fallback={
        <p
          data-required-chunk-loading="true"
          style={{ whiteSpace: "pre-wrap" }}
        >
          {text}
        </p>
      }
    >
      <LazyRich
        text={text}
        workspaceRoot={workspaceRoot}
        onExecute={onExecute}
      />
    </React.Suspense>
  );
}
function ActivityGroupCollapse({ label }: { label: string }) {
  return (
    <button
      className="activity-group-collapse"
      aria-label={`Collapse ${label}`}
      onClick={(event) => {
        const group = event.currentTarget.closest("details");
        const summary = group?.querySelector<HTMLElement>(":scope > summary");
        if (!group || !summary) return;
        group.open = false;
        requestAnimationFrame(() => summary.focus({ preventScroll: true }));
      }}
    >
      <Icon name="chevronDown" />
      <span>Collapse {label}</span>
    </button>
  );
}

type ContentProps = {
  blocks: Block[];
  tools?: Record<string, Data>;
  workspaceRoot?: string;
  onExecute?: (command: string) => void;
  onPreviewImage?: (asset: Data, trigger: HTMLElement) => void;
  groupActivity?: boolean;
  userMessage?: boolean;
  sessionId?: string;
};
const Content = React.memo(
  function Content({
    blocks,
    tools = {},
    workspaceRoot,
    onExecute,
    onPreviewImage,
    groupActivity = true,
    userMessage = false,
    sessionId = "",
  }: ContentProps) {
    if (userMessage) {
      const textBlocks = blocks.filter((block) => block.kind !== "image");
      const images = blocks.filter((block) => block.kind === "image");
      const props = {
        tools,
        workspaceRoot,
        onExecute,
        onPreviewImage,
        groupActivity,
        sessionId,
      };
      return (
        <>
          {textBlocks.length > 0 && (
            <div className="user-message-bubble">
              <Content blocks={textBlocks} {...props} />
            </div>
          )}
          <Content blocks={images} {...props} />
        </>
      );
    }
    const grouped = blockEntries(blocks);
    const entries: BlockEntry[] = groupActivity
      ? grouped
      : grouped.flatMap((entry) =>
          entry.kind === "activity"
            ? entry.blocks.map((block) => ({ kind: "block" as const, block }))
            : [entry],
        );
    return (
      <>
        {entries.map((entry) => {
          if (entry.kind === "activity") {
            const label = activityBlocksLabel(entry.blocks);
            return (
              <Disclosure
                className="transcript-flow-item activity-group inline-activity-group"
                key={entry.blocks[0].id}
                id={`${sessionId}.activity:${entry.blocks[0].id}`}
                renderDetail={() => (
                  <div className="activity-group-items">
                    <Content
                      blocks={entry.blocks}
                      tools={tools}
                      sessionId={sessionId}
                      workspaceRoot={workspaceRoot}
                      onExecute={onExecute}
                      onPreviewImage={onPreviewImage}
                      groupActivity={false}
                    />
                    <ActivityGroupCollapse label={label} />
                  </div>
                )}
              >
                <summary aria-label={`${label}, show activity`}>
                  <span>{label}</span>
                  <Icon name="chevronRight" />
                </summary>
              </Disclosure>
            );
          }
          if (entry.kind === "images") {
            return (
              <div
                className="transcript-flow-item flow-content message-images"
                key={entry.blocks[0].id}
              >
                {entry.blocks.map((image) => (
                  <button
                    className="message-image"
                    aria-label="Preview image attachment"
                    key={image.id}
                    onClick={(event) =>
                      onPreviewImage?.(
                        { id: image.artifactId, name: "Image attachment" },
                        event.currentTarget,
                      )
                    }
                  >
                    <img
                      src={`/v1/assets/${image.artifactId}`}
                      alt="Image attachment"
                    />
                  </button>
                ))}
              </div>
            );
          }
          const block = entry.block;
          if (block.kind === "thinking") {
            const summary = shortSummary(block.text);
            return (
              <Disclosure
                id={`${sessionId}.${block.id}`}
                key={block.id}
                className="transcript-flow-item flow-activity activity-item thinking"
                renderDetail={() => (
                  <div className="activity-detail">{block.text}</div>
                )}
              >
                <summary aria-label={`Think, ${summary}`}>
                  <span className="activity-icon">
                    <ActivityIcon name="think" />
                  </span>
                  <span className="tool-name">Think</span>
                  {summary && <span className="activity-separator">·</span>}
                  <span className="tool-summary">{summary}</span>
                </summary>
              </Disclosure>
            );
          }
          if (block.kind === "toolCall") {
            const state = block.callId ? tools[block.callId] : undefined;
            const phase = state?.phase ?? "pending";
            const name = state?.name ?? block.name ?? "";
            const args = {
              ...(block.arguments ?? {}),
              ...(state?.arguments ?? {}),
            };
            const summary = toolSummary(name, args);
            const stateLabel = phaseLabel(phase);
            const showState = phase !== "completed";
            return (
              <Disclosure
                id={`${sessionId}.${block.id}`}
                className={`transcript-flow-item flow-activity activity-item tool ${phase} ${activePhases.has(phase) ? "active" : ""}`}
                key={block.id}
                renderDetail={() => (
                  <div className="activity-detail">
                    <pre>{JSON.stringify(args, null, 2)}</pre>
                    {state && (
                      <Content
                        blocks={state.blocks ?? []}
                        sessionId={sessionId}
                        tools={tools}
                        workspaceRoot={workspaceRoot}
                        onExecute={onExecute}
                        onPreviewImage={onPreviewImage}
                      />
                    )}
                  </div>
                )}
              >
                <summary
                  aria-label={`${toolLabel(name)}, ${summary || stateLabel}, ${stateLabel}`}
                >
                  <span className="activity-icon" aria-hidden="true">
                    <ActivityIcon name={toolIcon(name)} />
                  </span>
                  <span className="tool-name">{toolLabel(name)}</span>
                  {summary && <span className="activity-separator">·</span>}
                  <span className="tool-summary">{summary}</span>
                  {showState && (
                    <span className={`activity-state ${phase}`}>
                      <span
                        className="activity-status-mark"
                        aria-hidden="true"
                      />
                      {stateLabel}
                    </span>
                  )}
                </summary>
              </Disclosure>
            );
          }
          const b = block;
          if (b.kind === "text" && !b.text?.trim() && !b.artifactId)
            return null;
          return b.kind === "text" ? (
            <div className="transcript-flow-item flow-content" key={b.id}>
              <Rich
                text={b.text ?? ""}
                workspaceRoot={workspaceRoot}
                onExecute={onExecute}
              />
              {b.artifactId && <ArtifactPreview id={b.artifactId} />}
            </div>
          ) : (
            <pre className="transcript-flow-item flow-content" key={b.id}>
              {b.text ?? b.kind}
            </pre>
          );
        })}
      </>
    );
  },
  (previous, next) =>
    previous.blocks === next.blocks &&
    previous.tools === next.tools &&
    previous.workspaceRoot === next.workspaceRoot &&
    previous.groupActivity === next.groupActivity &&
    previous.userMessage === next.userMessage &&
    previous.sessionId === next.sessionId,
);
export { ActivityGroupCollapse, Content };
