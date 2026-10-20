import { viewStorage as localStorage } from "../../view-storage.js";
import { TurnNavigator } from "../../components/turn-navigator.js";
import type { ConversationProps } from "./conversation-types.js";
import { renderEarlierMessages } from "./earlier-messages.js";
import { renderMessages } from "./messages.js";
import { renderNotices } from "./notices.js";

export function Conversation(props: ConversationProps) {
  const {
    state,
    session,
    historyOwner,
    restoringScroll,
    readingAnchors,
    scroll,
    lastScrollMetrics,
    latestRef,
    scrollWriter,
    cancelScrollRestoration,
    setAtLatest,
    jumpToLatest,
    composerRail,
    latestJumpGeneration,
    turnMarks,
    children,
  } = props;
  return (
    <div className="conversation">
      <div
        className="transcript"
        ref={scroll}
        onScroll={() => {
          const s = scroll.current!;
          if (restoringScroll.current || historyOwner !== state.selected)
            return;
          const previous = lastScrollMetrics.current;
          const grewAtLatest =
            latestRef.current &&
            previous &&
            s.scrollHeight > previous.height &&
            Math.abs(s.scrollTop - previous.top) < 2;
          lastScrollMetrics.current = {
            height: s.scrollHeight,
            top: s.scrollTop,
          };
          if (grewAtLatest) {
            s.scrollTop = s.scrollHeight;
            lastScrollMetrics.current.top = s.scrollTop;
            return;
          }
          const bottom = s.scrollHeight - s.scrollTop - s.clientHeight < 64;
          const selectedId = state.selected;
          if (selectedId) {
            if (bottom) readingAnchors.current.delete(selectedId);
            else {
              const visible = Array.from(
                s.querySelectorAll<HTMLElement>("[data-transcript-id]"),
              ).find(
                (node) =>
                  node.getBoundingClientRect().bottom >
                  s.getBoundingClientRect().top,
              );
              if (visible)
                readingAnchors.current.set(selectedId, {
                  id: visible.dataset.transcriptId!,
                  offset:
                    visible.getBoundingClientRect().top -
                    s.getBoundingClientRect().top,
                });
            }
          }
          if (latestRef.current !== bottom) setAtLatest(bottom);
          if (selectedId)
            scrollWriter.current?.save(selectedId, s.scrollTop, bottom);
        }}
      >
        <div className="rail">
          {renderEarlierMessages(props)}
          {renderMessages(props)}
          {renderNotices(props)}
        </div>
      </div>
      {session && (
        <TurnNavigator
          key={session.id}
          marks={turnMarks}
          scroller={scroll}
          onNavigate={(id) => {
            const viewport = scroll.current;
            const row = viewport?.querySelector<HTMLElement>(
              `[data-transcript-id="${CSS.escape(`message:${id}`)}"]`,
            );
            if (!viewport || !row) return;
            latestJumpGeneration.current++;
            cancelScrollRestoration.current?.();
            scrollWriter.current?.cancel();
            setAtLatest(false);
            viewport.scrollTop +=
              row.getBoundingClientRect().top -
              viewport.getBoundingClientRect().top -
              24;
          }}
        />
      )}
      <div className="composer-rail" ref={composerRail}>
        <button
          ref={jumpToLatest}
          className={`jump ${latestRef.current ? "hidden" : ""}`}
          aria-hidden={latestRef.current}
          tabIndex={latestRef.current ? -1 : 0}
          onClick={() => {
            latestJumpGeneration.current++;
            cancelScrollRestoration.current?.();
            scrollWriter.current?.cancel();
            const selectedId = state.selected;
            if (selectedId) {
              readingAnchors.current.delete(selectedId);
              localStorage.removeItem(`suri.scroll.${selectedId}`);
            }
            setAtLatest(true);
            if (scroll.current) {
              scroll.current.scrollTop = scroll.current.scrollHeight;
              lastScrollMetrics.current = {
                height: scroll.current.scrollHeight,
                top: scroll.current.scrollTop,
              };
            }
          }}
        >
          Jump to latest ↓
        </button>
        {children}
      </div>
    </div>
  );
}
