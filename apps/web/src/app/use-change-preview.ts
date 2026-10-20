import { useEffect, useRef, useState } from "react";
import type { Data } from "../../../../packages/protocol/src/index.js";
import type { State } from "../store.js";

export function useChangePreview({
  state,
  workspace,
  fileMenu,
}: {
  state: State;
  workspace: Data | undefined;
  fileMenu: unknown;
}) {
  const [transientChange, setTransientChange] = useState<string>();
  const previewTrigger = useRef<HTMLElement | undefined>(undefined);
  const restoringPreviewFocus = useRef(false);
  const previewLeaveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const keepChangePreview = () => clearTimeout(previewLeaveTimer.current);
  const dismissChangePreview = () => {
    keepChangePreview();
    setTransientChange(undefined);
  };
  const leaveChangePreview = () => {
    keepChangePreview();
    previewLeaveTimer.current = setTimeout(() => {
      const focused = document.activeElement;
      if (
        !focused?.closest(".workspace-details") &&
        focused !== previewTrigger.current
      )
        setTransientChange(undefined);
    }, 260);
  };
  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (
        event.key === "Escape" &&
        transientChange &&
        !fileMenu &&
        !(
          event.target instanceof Element &&
          event.target.closest('[role="menu"], [role="dialog"]')
        )
      ) {
        event.preventDefault();
        event.stopPropagation();
        dismissChangePreview();
        if (document.activeElement?.closest(".workspace-details")) {
          restoringPreviewFocus.current = true;
          previewTrigger.current?.focus();
          restoringPreviewFocus.current = false;
        }
      }
    };
    window.addEventListener("keydown", escape, true);
    return () => window.removeEventListener("keydown", escape, true);
  }, [transientChange, fileMenu]);
  useEffect(() => {
    dismissChangePreview();
    return keepChangePreview;
  }, [workspace?.id, state.selected]);
  useEffect(() => {
    const resize = () => {
      if (window.innerWidth <= 1100) dismissChangePreview();
    };
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);
  return {
    transientChange,
    keepChangePreview,
    dismissChangePreview,
    leaveChangePreview,
  };
}
