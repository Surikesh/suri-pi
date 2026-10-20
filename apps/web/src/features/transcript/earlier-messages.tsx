import type { Message } from "../../../../../packages/protocol/src/index.js";
import { command, report } from "../../store.js";
import { mergeTranscriptMessages } from "../../domain/presentation.js";
import type { ConversationProps } from "./conversation-types.js";
import { LIVE_TRANSCRIPT_MESSAGE_LIMIT } from "./constants.js";

export function renderEarlierMessages(props: ConversationProps) {
  const {
    state,
    session,
    projection,
    scroll,
    visibleHistoryCursor,
    visibleOlder,
    historyLoading,
    setHistoryLoading,
    historyRequest,
    latestJumpGeneration,
    historyCache,
    setOlder,
    setHistoryCursor,
    setAtLatest,
  } = props;
  return (
    session &&
    visibleHistoryCursor !== null &&
    (projection.messages.length >= LIVE_TRANSCRIPT_MESSAGE_LIMIT ||
      visibleOlder.length > 0) && (
      <button
        className="earlier-messages"
        disabled={historyLoading}
        onClick={() => {
          if (historyLoading) return;
          const request = ++historyRequest.current;
          const jumpGeneration = latestJumpGeneration.current;
          const sessionId = session.id;
          const transcript = scroll.current;
          const anchor = transcript
            ? [
                ...transcript.querySelectorAll<HTMLElement>(
                  "[data-transcript-id]",
                ),
              ].find(
                (element) =>
                  element.getBoundingClientRect().bottom >=
                  transcript.getBoundingClientRect().top,
              )
            : undefined;
          const anchorId = anchor?.dataset.transcriptId;
          const anchorTop = anchor?.getBoundingClientRect().top;
          setHistoryLoading(true);
          void command(
            "session.history",
            {
              before: visibleHistoryCursor,
              // The live projection renders only its newest window.
              // The first page must reach beyond that window.
              limit: visibleHistoryCursor === undefined ? 200 : 100,
            },
            sessionId,
          )
            .then((h) => {
              if (
                request !== historyRequest.current ||
                state.selected !== sessionId
              )
                return;
              const messages = mergeTranscriptMessages(
                (h.messages ?? []).filter(
                  (message: Message) =>
                    message.role === "user" || message.role === "assistant",
                ),
                historyCache.current.get(sessionId)?.messages ?? [],
              );
              const cursor = h.cursor ?? null;
              historyCache.current.delete(sessionId);
              historyCache.current.set(sessionId, {
                messages,
                cursor,
              });
              if (historyCache.current.size > 4)
                historyCache.current.delete(
                  historyCache.current.keys().next().value!,
                );
              setOlder(messages);
              setHistoryCursor(cursor);
              if (jumpGeneration !== latestJumpGeneration.current) return;
              setAtLatest(false);
              requestAnimationFrame(() => {
                if (
                  jumpGeneration !== latestJumpGeneration.current ||
                  request !== historyRequest.current ||
                  state.selected !== sessionId
                )
                  return;
                const next = anchorId
                  ? scroll.current?.querySelector<HTMLElement>(
                      `[data-transcript-id="${CSS.escape(anchorId)}"]`,
                    )
                  : undefined;
                if (next && anchorTop !== undefined && scroll.current)
                  scroll.current.scrollTop +=
                    next.getBoundingClientRect().top - anchorTop;
              });
            })
            .catch(report)
            .finally(() => {
              if (request === historyRequest.current) setHistoryLoading(false);
            });
        }}
      >
        {historyLoading ? "Loading earlier messages…" : "Earlier messages"}
      </button>
    )
  );
}
