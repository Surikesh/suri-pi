import { report } from "../../store.js";
import { viewStorage as localStorage } from "../../view-storage.js";
import { SubagentStatus } from "../../components/subagent-status.js";
import { noticeIdentity } from "../../domain/presentation.js";
import type { ConversationProps } from "./conversation-types.js";

export function renderNotices(props: ConversationProps) {
  const {
    state,
    session,
    projection,
    draft,
    setDraft,
    dismissedNotices,
    setDismissedNotices,
  } = props;
  return (
    <>
      {Object.entries(projection.extensions ?? {})
        .filter(
          ([key, item]) =>
            item.type !== "extension.status" &&
            key !== "extension.widget:subagent-inspect",
        )
        .map(([key, item]) =>
          key === "extension.widget:subagent-async" ? (
            <SubagentStatus key={key} lines={item.lines} />
          ) : (
            <div className="notice" key={key}>
              {item.type === "extension.editor" ? (
                <button
                  onClick={() => {
                    if (draft) {
                      report(
                        new Error(
                          "Keep or send your current draft before applying extension text.",
                        ),
                      );
                      return;
                    }
                    setDraft(item.text);
                    localStorage.setItem(
                      `suri.draft.${state.selected}`,
                      item.text,
                    );
                  }}
                >
                  Use extension draft
                </button>
              ) : (
                <>
                  {item.text && <p>{item.text}</p>}
                  {item.lines?.map((line: string, index: number) => (
                    <p key={index}>{line}</p>
                  ))}
                </>
              )}
            </div>
          ),
        )}
      {projection.notices.flatMap((notice) => {
        const identity = session
          ? noticeIdentity(session.id, notice)
          : undefined;
        const dismissed =
          identity &&
          (dismissedNotices.has(identity) ||
            localStorage.getItem(`suri.noticeDismissed.${identity}`) ===
              "true");
        if (dismissed) return [];
        const blocking = notice.severity === "error";
        return [
          <div
            className={`notice ${blocking ? "blocking" : "informational"}`}
            role={blocking ? "alert" : "note"}
            key={
              identity ??
              `${notice.code ?? "notice"}:${notice.eventSeq ?? "unknown"}`
            }
          >
            <span>{notice.text}</span>
            {!blocking && identity && (
              <button
                className="notice-dismiss"
                aria-label="Dismiss notification"
                onClick={() => {
                  localStorage.setItem(
                    `suri.noticeDismissed.${identity}`,
                    "true",
                  );
                  setDismissedNotices((current) =>
                    new Set(current).add(identity),
                  );
                }}
              >
                ×
              </button>
            )}
          </div>,
        ];
      })}
    </>
  );
}
