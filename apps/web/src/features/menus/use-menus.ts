import { useState } from "react";
import { type Data } from "../../../../../packages/protocol/src/index.js";
import { dismiss } from "../../store.js";

export function useFileMenu() {
  const [fileMenu, setFileMenu] = useState<
    | {
        path: string;
        x: number;
        y: number;
        trigger: HTMLElement;
        source: "changes" | "transcript";
        workspaceId?: string;
        absolutePath: string;
      }
    | undefined
  >();
  const [fileMenuStatus, setFileMenuStatus] = useState("");
  const closeFileMenu = () => {
    const trigger = fileMenu?.trigger;
    setFileMenu(undefined);
    requestAnimationFrame(() => trigger?.focus());
  };
  return {
    fileMenu,
    setFileMenu,
    fileMenuStatus,
    setFileMenuStatus,
    closeFileMenu,
  };
}

export function useSessionProjectMenus() {
  const [sessionMenu, setSessionMenu] = useState<
    { session: Data; x: number; y: number; trigger: HTMLElement } | undefined
  >();
  const [sessionMenuName, setSessionMenuName] = useState("");
  const [sessionMenuRenaming, setSessionMenuRenaming] = useState(false);
  const [projectMenu, setProjectMenu] = useState<
    { project: Data; x: number; y: number; trigger: HTMLElement } | undefined
  >();
  const [confirmProjectRemoval, setConfirmProjectRemoval] = useState(false);
  const closeSessionMenu = () => {
    const trigger = sessionMenu?.trigger;
    setSessionMenu(undefined);
    setSessionMenuRenaming(false);
    requestAnimationFrame(() => {
      if (!document.querySelector('[role="dialog"]')) trigger?.focus();
    });
  };
  const openSessionMenu = (
    target: Data,
    trigger: HTMLElement,
    x: number,
    y: number,
  ) => {
    dismiss();
    setSessionMenuName(target.name);
    setSessionMenuRenaming(false);
    setSessionMenu({
      session: target,
      trigger,
      x: Math.max(8, Math.min(x, window.innerWidth - 250)),
      y: Math.max(8, Math.min(y, window.innerHeight - 520)),
    });
  };
  const closeProjectMenu = () => {
    const trigger = projectMenu?.trigger;
    setProjectMenu(undefined);
    setConfirmProjectRemoval(false);
    requestAnimationFrame(() => {
      if (!document.querySelector('[role="dialog"]')) trigger?.focus();
    });
  };
  const openProjectMenu = (
    target: Data,
    trigger: HTMLElement,
    x: number,
    y: number,
  ) => {
    dismiss();
    setSessionMenu(undefined);
    setConfirmProjectRemoval(false);
    setProjectMenu({
      project: target,
      trigger,
      x: Math.max(8, Math.min(x, window.innerWidth - 250)),
      y: Math.max(8, Math.min(y, window.innerHeight - 210)),
    });
  };
  return {
    sessionMenu,
    sessionMenuName,
    setSessionMenuName,
    sessionMenuRenaming,
    setSessionMenuRenaming,
    projectMenu,
    confirmProjectRemoval,
    setConfirmProjectRemoval,
    closeSessionMenu,
    openSessionMenu,
    closeProjectMenu,
    openProjectMenu,
  };
}
