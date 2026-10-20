import { useEffect, useState } from "react";
import type React from "react";
import type { State } from "../store.js";

export function useNarrow() {
  const [narrow, setNarrow] = useState(window.innerWidth < 900);
  useEffect(() => {
    const query = window.matchMedia("(max-width: 899px)");
    const update = () => setNarrow(query.matches);
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return narrow;
}

export function useShellLayout({
  state,
  draft,
  editor,
  composerRail,
  updateComposerClearance,
  viewOptions,
  setViewOptions,
  viewOptionsTrigger,
}: {
  state: State;
  draft: string;
  editor: React.RefObject<HTMLTextAreaElement | null>;
  composerRail: React.RefObject<HTMLDivElement | null>;
  updateComposerClearance: () => void;
  viewOptions: boolean;
  setViewOptions: React.Dispatch<React.SetStateAction<boolean>>;
  viewOptionsTrigger: React.RefObject<HTMLButtonElement | null>;
}) {
  useEffect(() => {
    const target = editor.current;
    if (!target) return;
    target.style.height = "0px";
    const height = Math.min(116, Math.max(58, target.scrollHeight));
    target.style.height = `${height}px`;
    target.style.overflowY = target.scrollHeight > height ? "auto" : "hidden";
    updateComposerClearance();
  }, [draft, state.selected]);
  useEffect(() => {
    const target = composerRail.current;
    const conversation = target?.closest<HTMLElement>(".conversation");
    if (!target || !conversation) return;
    const update = updateComposerClearance;
    update();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(update);
    observer.observe(target);
    return () => {
      observer.disconnect();
      conversation.style.removeProperty("--composer-clearance");
    };
  }, []);
  useEffect(() => {
    if (!viewOptions) return;
    const outside = (event: PointerEvent) => {
      const target = event.target as HTMLElement;
      if (
        target.closest(".view-options") ||
        viewOptionsTrigger.current?.contains(target)
      )
        return;
      setViewOptions(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [viewOptions]);
}
