import { useEffect, useLayoutEffect, useRef } from "react";
import type { Data } from "../../../../../packages/protocol/src/index.js";
import type { State } from "../../store.js";
import type { createScrollPositionWriter } from "../../scroll-position.js";
import { viewStorage as localStorage } from "../../view-storage.js";

export function useTranscriptFollow({
  latestRef,
}: {
  latestRef: { current: boolean };
}) {
  const scroll = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const transcript = scroll.current;
    const content = transcript?.querySelector<HTMLElement>(":scope > .rail");
    if (!transcript || !content || typeof ResizeObserver === "undefined")
      return;
    const observer = new ResizeObserver(() => {
      if (latestRef.current)
        transcript.scrollTo({ top: transcript.scrollHeight });
    });
    observer.observe(content);
    return () => observer.disconnect();
  }, []);
  return { scroll };
}

export function useScrollRestoration({
  state,
  projection,
  historyOwner,
  scroll,
  latestRef,
  scrollWriter,
  cancelScrollRestoration,
}: {
  state: State;
  projection: Data;
  historyOwner: string | undefined;
  scroll: { current: HTMLDivElement | null };
  latestRef: { current: boolean };
  scrollWriter: {
    current: ReturnType<typeof createScrollPositionWriter> | undefined;
  };
  cancelScrollRestoration: { current: (() => void) | undefined };
}) {
  const readingAnchors = useRef(
    new Map<string, { id: string; offset: number }>(),
  );
  const restoringScroll = useRef(false);
  useEffect(() => {
    if (latestRef.current)
      scroll.current?.scrollTo({ top: scroll.current.scrollHeight });
  }, [projection.seq]);
  useEffect(
    () => () => {
      scrollWriter.current?.cancel();
    },
    [],
  );
  useLayoutEffect(() => {
    const sessionId = state.selected;
    if (!sessionId || historyOwner !== sessionId) return;
    const transcript = scroll.current;
    if (!transcript) return;
    const anchor = readingAnchors.current.get(sessionId);
    const saved = localStorage.getItem(`suri.scroll.${sessionId}`);
    if (!anchor && !saved) return;
    let active = true;
    // Keep the saved message identity until history brings it back. A numeric
    // position is only a temporary fallback, never a replacement for the anchor.
    restoringScroll.current = true;
    let awaitingAnchor = !!anchor;
    const restore = () => {
      if (!active || state.selected !== sessionId) return;
      const message =
        anchor &&
        transcript.querySelector<HTMLElement>(
          `[data-transcript-id="${CSS.escape(anchor.id)}"]`,
        );
      if (message) {
        awaitingAnchor = false;
        transcript.scrollTop +=
          message.getBoundingClientRect().top -
          transcript.getBoundingClientRect().top -
          anchor!.offset;
      } else if (awaitingAnchor && saved) {
        transcript.scrollTop = Number(saved);
      } else if (!anchor && saved) transcript.scrollTop = Number(saved);
    };
    restore();
    const observer = new ResizeObserver(restore);
    const rail = transcript.querySelector(":scope > .rail");
    if (rail) observer.observe(rail);
    const mutations = new MutationObserver(restore);
    if (rail) mutations.observe(rail, { childList: true, subtree: true });
    const stop = () => {
      active = false;
      observer.disconnect();
      mutations.disconnect();
      restoringScroll.current = false;
      if (cancelScrollRestoration.current === stop)
        cancelScrollRestoration.current = undefined;
    };
    cancelScrollRestoration.current = stop;
    transcript.addEventListener("wheel", stop, { passive: true });
    transcript.addEventListener("touchstart", stop, { passive: true });
    const pointerInput = (event: PointerEvent) => {
      if (!(event.target as Element).closest(".earlier-messages")) stop();
    };
    transcript.addEventListener("pointerdown", pointerInput, { passive: true });
    const keyboardInput = (event: KeyboardEvent) => {
      if (!(event.target as Element).closest(".earlier-messages")) stop();
    };
    transcript.addEventListener("keydown", keyboardInput);
    // Scroll events can arrive after a frame (including browser scroll anchoring).
    // Only explicit user input ends restoration; scroll itself is not evidence.
    return () => {
      stop();
      transcript.removeEventListener("wheel", stop);
      transcript.removeEventListener("touchstart", stop);
      transcript.removeEventListener("pointerdown", pointerInput);
      transcript.removeEventListener("keydown", keyboardInput);
    };
  }, [state.selected, historyOwner]);
  return { readingAnchors, restoringScroll };
}
