import { useEffect, useMemo, useRef, useState } from "react";
import type { Data } from "../../../../../packages/protocol/src/index.js";
import { command } from "../../store.js";
import { copyText } from "../../file-preview.js";
import {
  parseGitStatus,
  untrackedDiff,
  type ChangedFile,
} from "../../change-review.js";

export function useChanges({
  workspaceId,
  workspaceRoot,
  tab,
  setTab,
  transientChange,
  requestedChange,
  requestedFile,
}: {
  workspaceId: string;
  workspaceRoot: string;
  tab: string;
  setTab: (value: string) => void;
  transientChange?: string;
  requestedChange?: { path: string; requestId: number };
  requestedFile?: { path: string; requestId: number };
}) {
  const [changeFiles, setChangeFiles] = useState<ChangedFile[]>([]);
  const [changeFilter, setChangeFilter] = useState("");
  const filteredChangeFiles = useMemo(() => {
    const query = changeFilter.trim().toLocaleLowerCase();
    if (!query) return changeFiles;
    return changeFiles.filter((file) =>
      `${file.path}\n${file.renamedFrom ?? ""}`
        .toLocaleLowerCase()
        .includes(query),
    );
  }, [changeFiles, changeFilter]);
  const [pinnedChange, setSelectedChange] = useState("");
  const selectedChange = transientChange ?? pinnedChange;
  const [patches, setPatches] = useState<{
    path: string;
    staged: string;
    unstaged: string;
    files: ChangedFile[];
    binaryFile?: Data;
    binaryReadError?: string;
  }>();
  const changeDiff =
    patches?.path === selectedChange && patches.files === changeFiles
      ? [patches.staged, patches.unstaged].join("\n")
      : "";
  const statusRequest = useRef(0);
  const [changesLoading, setChangesLoading] = useState(false);
  const [changeError, setChangeError] = useState("");
  const [changeNotice, setChangeNotice] = useState("");
  const actionRequest = useRef(0);
  useEffect(() => {
    actionRequest.current++;
    setChangeNotice("");
    return () => {
      actionRequest.current++;
    };
  }, [selectedChange]);
  const refreshChanges = async (preferredPath?: string) => {
    const request = ++statusRequest.current;
    setChangesLoading(true);
    setChangeError("");
    try {
      const status = await command("git.status", { workspaceId });
      if (request !== statusRequest.current) return;
      const files = parseGitStatus(String(status.text ?? ""));
      setChangeFiles(files);
      setSelectedChange((current) => {
        const preferred = preferredPath || current;
        return preferred || files[0]?.path || "";
      });
    } catch (error) {
      if (request !== statusRequest.current) return;
      setChangeFiles([]);
      setSelectedChange("");
      setChangeError(error instanceof Error ? error.message : String(error));
    } finally {
      if (request === statusRequest.current) setChangesLoading(false);
    }
  };
  useEffect(() => {
    setChangeFilter("");
  }, [workspaceId]);
  useEffect(() => {
    if (tab === "Changes") void refreshChanges(requestedChange?.path);
    return () => {
      statusRequest.current++;
    };
  }, [workspaceId, tab, requestedChange?.requestId, transientChange]);
  useEffect(() => {
    if (!requestedChange || transientChange) return;
    setTab("Changes");
    setSelectedChange(requestedChange.path);
  }, [requestedChange?.requestId]);
  useEffect(() => {
    if (!requestedFile || transientChange) return;
    setTab("Files");
  }, [requestedFile?.requestId]);
  useEffect(() => {
    if (tab !== "Changes" || !selectedChange) {
      setPatches(undefined);
      return;
    }
    let current = true;
    setPatches(undefined);
    setChangeError("");
    const file = changeFiles.find(
      (candidate) => candidate.path === selectedChange,
    );
    void Promise.all([
      command("git.diff", { workspaceId, path: selectedChange, staged: true }),
      command("git.diff", { workspaceId, path: selectedChange, staged: false }),
    ])
      .then(async ([staged, unstaged]) => {
        const stagedText = String(staged.text ?? "");
        let text = String(unstaged.text ?? "");
        let binaryFile: Data | undefined;
        let binaryReadError: string | undefined;
        if (!stagedText && !text && file?.untracked) {
          const result = await command("file.read", {
            workspaceId,
            path: selectedChange,
          });
          if (result.encoding === "utf8") {
            if (result.truncated)
              throw Error(
                "This new file exceeds the preview limit. Open it externally to review the complete contents.",
              );
            text = untrackedDiff(selectedChange, result.content);
          } else {
            binaryFile = result;
            text = "Binary file · diff preview unavailable";
          }
        }
        const binary = /binary/i.test(`${stagedText}\n${text}`);
        if (binary && !binaryFile) {
          try {
            binaryFile = await command("file.read", {
              workspaceId,
              path: selectedChange,
            });
          } catch (error) {
            binaryReadError =
              error instanceof Error ? error.message : String(error);
          }
        }
        if (current)
          setPatches({
            path: selectedChange,
            staged: stagedText,
            unstaged: text,
            files: changeFiles,
            binaryFile,
            binaryReadError,
          });
      })
      .catch((error) => {
        if (current)
          setChangeError(
            error instanceof Error ? error.message : String(error),
          );
      });
    return () => {
      current = false;
    };
  }, [workspaceId, tab, selectedChange, changeFiles]);
  const changeAction = async (
    type: "open" | "openWith" | "reveal" | "copy" | "copyPath",
  ) => {
    if (!selectedChange) return;
    const request = ++actionRequest.current;
    setChangeNotice("");
    try {
      if (type === "copyPath") {
        await copyText(`${workspaceRoot}/${selectedChange}`);
        if (request === actionRequest.current) setChangeNotice("Path copied.");
      } else if (type === "copy") {
        const result = await command("file.read", {
          workspaceId,
          path: selectedChange,
        });
        if (result.encoding !== "utf8" || result.truncated)
          throw Error("Only complete text files can be copied.");
        await copyText(result.content);
        if (request === actionRequest.current)
          setChangeNotice("File contents copied.");
      } else {
        await command(`file.${type}`, { workspaceId, path: selectedChange });
        if (request !== actionRequest.current) return;
        setChangeNotice(
          type === "openWith"
            ? "Choose an application in the macOS dialog."
            : type === "reveal"
              ? "Revealed in Finder."
              : "Opened in the default application.",
        );
      }
    } catch (error) {
      if (request === actionRequest.current)
        setChangeNotice(error instanceof Error ? error.message : String(error));
    }
  };
  return {
    changeFiles,
    changeFilter,
    setChangeFilter,
    filteredChangeFiles,
    selectedChange,
    setSelectedChange,
    patches,
    changeDiff,
    changesLoading,
    changeError,
    changeNotice,
    refreshChanges,
    changeAction,
  };
}
