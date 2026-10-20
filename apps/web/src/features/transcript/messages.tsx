import { Icon } from "../../components/ui.js";
import { appIcon } from "../../branding.js";
import {
  activityGroupLabel,
  copyableMessageText,
} from "../../domain/presentation.js";
import type { ConversationProps } from "./conversation-types.js";
import { ActivityGroupCollapse, Content } from "./content.js";
import { ChangedFiles } from "./changed-files.js";
import { LazyActivityGroup } from "./lazy-activity-group.js";

export function renderMessages(props: ConversationProps) {
  const {
    session,
    workspace,
    projection,
    transcriptMessages,
    transcriptItems,
    changedByMessage,
    previewImage,
    executeInTerminal,
    pinChange,
    fileAction,
    setFileMenu,
    setFileMenuStatus,
    act,
    create,
  } = props;
  return !session ? (
    <div className="empty">
      <img className="empty-mark" src={appIcon} alt="" />
      <h1>A place for focused work.</h1>
      <p>
        Choose a project and start a Pi session.
        <br />
        Your work stays local and survives closing this window.
      </p>
      <button className="primary" onClick={() => void act(() => create())}>
        New session
      </button>
    </div>
  ) : transcriptMessages.length === 0 ? (
    <div className="empty">
      <h1>What are we working on?</h1>
      <p>{workspace?.root}</p>
      <p className="muted">Pi tools run with your macOS permissions.</p>
    </div>
  ) : (
    transcriptItems.map((entry) => {
      if (entry.kind === "activity") {
        const label = activityGroupLabel(entry.messages);
        return (
          <LazyActivityGroup
            className="activity-group"
            data-transcript-id={`activity:${entry.messages[0].messageId}`}
            key={entry.messages[0].messageId}
            label={label}
            sessionId={session.id}
            render={() => (
              <>
                {entry.messages.map((message) => (
                  <article
                    className="message assistant activity-message"
                    key={message.messageId}
                  >
                    <div className="message-body">
                      <Content
                        blocks={message.blocks}
                        sessionId={session.id}
                        tools={projection.tools}
                        workspaceRoot={workspace?.root}
                        onExecute={executeInTerminal}
                        onPreviewImage={previewImage}
                        groupActivity={false}
                      />
                    </div>
                  </article>
                ))}
                <ActivityGroupCollapse label={label} />
              </>
            )}
          />
        );
      }
      const m = entry.message;
      const copyableText = copyableMessageText(m.blocks);
      return (
        <article
          key={m.messageId}
          data-transcript-id={`message:${m.messageId}`}
          className={`message ${m.role}`}
        >
          <div className="message-body">
            <Content
              blocks={m.blocks}
              sessionId={session.id}
              userMessage={m.role === "user"}
              tools={projection.tools}
              workspaceRoot={workspace?.root}
              onExecute={executeInTerminal}
              onPreviewImage={previewImage}
            />
          </div>
          {m.role === "assistant" && changedByMessage.has(m.messageId) && (
            <ChangedFiles
              paths={changedByMessage.get(m.messageId)!}
              pin={pinChange}
              open={(path) => void fileAction(path, "open")}
              menu={(path, x, y, trigger) => {
                setFileMenuStatus("");
                setFileMenu({
                  path,
                  trigger,
                  source: "changes",
                  workspaceId: workspace?.id,
                  absolutePath: workspace ? `${workspace.root}/${path}` : path,
                  x: Math.max(8, Math.min(x, innerWidth - 236)),
                  y: Math.max(8, Math.min(y, innerHeight - 250)),
                });
              }}
            />
          )}
          {copyableText && (
            <div className="message-meta">
              <button
                aria-label="Copy message"
                title="Copy message"
                onClick={() => void navigator.clipboard.writeText(copyableText)}
              >
                <Icon name="copy" />
              </button>
            </div>
          )}
        </article>
      );
    })
  );
}
