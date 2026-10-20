import { useCallback, useEffect } from "react";
import type { Data } from "../../../../packages/protocol/src/index.js";
import { command, report, type State } from "../store.js";
import { copyText } from "../file-preview.js";
import type { useFileMenu } from "../features/menus/index.js";
import type { DialogState, ShellState } from "./use-app-state.js";

export function useFileActions({
  state,
  workspace,
  fileMenuState,
  dialogs,
  shell,
  dismissChangePreview,
}: {
  state: State;
  workspace: Data | undefined;
  fileMenuState: ReturnType<typeof useFileMenu>;
  dialogs: DialogState;
  shell: ShellState;
  dismissChangePreview: () => void;
}) {
  const { fileMenu, setFileMenuStatus, closeFileMenu } = fileMenuState;
  const { setRequestedChange, setRequestedFile } = dialogs;
  const { setDetails, setTerminalExecution } = shell;
  useEffect(() => {
    setRequestedChange(undefined);
    setRequestedFile(undefined);
  }, [workspace?.id]);
  const pinChange = (path: string) => {
    dismissChangePreview();
    setDetails(true);
    setRequestedChange({ path, requestId: performance.now() });
  };
  const fileAction = async (
    path: string,
    type: "open" | "openWith" | "reveal" | "copy" | "copyPath",
    targetWorkspace: Data | undefined = workspace,
    absolutePath?: string,
  ) => {
    setFileMenuStatus("");
    try {
      if (type === "copyPath") {
        const fullPath =
          absolutePath ??
          (targetWorkspace ? `${targetWorkspace.root}/${path}` : path);
        await copyText(fullPath);
        setFileMenuStatus("Path copied.");
      } else if (!targetWorkspace) {
        const target = absolutePath ?? path;
        if (!window.confirm(`Allow Suri to access this file?\n\n${target}`))
          return;
        if (type === "copy") {
          const result = await command("externalFile.read", {
            path: target,
            confirmed: true,
          });
          if (result.encoding !== "utf8" || result.truncated)
            throw Error("Only complete text files can be copied.");
          await copyText(result.content);
          setFileMenuStatus("File contents copied.");
        } else {
          await command(`externalFile.${type}`, {
            path: target,
            confirmed: true,
          });
          closeFileMenu();
        }
      } else if (type === "copy") {
        const result = await command("file.read", {
          workspaceId: targetWorkspace.id,
          path,
        });
        if (result.encoding !== "utf8" || result.truncated)
          throw Error("Only complete text files can be copied.");
        await copyText(result.content);
        setFileMenuStatus("File contents copied.");
      } else {
        await command(`file.${type}`, {
          workspaceId: targetWorkspace.id,
          path,
        });
        closeFileMenu();
      }
    } catch (error) {
      setFileMenuStatus(error instanceof Error ? error.message : String(error));
    }
  };
  const fileMenuWorkspace = fileMenu?.workspaceId
    ? state.catalog.workspaces.find(
        (candidate: Data) => candidate.id === fileMenu.workspaceId,
      )
    : undefined;
  const executeInTerminal = useCallback(
    (text: string) => {
      if (!workspace) {
        report(new Error("Choose a workspace before running a command."));
        return;
      }
      setTerminalExecution({
        id: crypto.randomUUID(),
        workspaceId: workspace.id,
        command: text,
      });
      setDetails(true);
    },
    [workspace?.id],
  );
  return { pinChange, fileAction, fileMenuWorkspace, executeInTerminal };
}
