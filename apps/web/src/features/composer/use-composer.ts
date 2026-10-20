import type React from "react";
import { useEffect } from "react";
import { type Data } from "../../../../../packages/protocol/src/index.js";
import { command, report, upload, type State } from "../../store.js";
import { viewStorage as localStorage } from "../../view-storage.js";
import { findWorkspaceFiles } from "../transcript/index.js";

type Setter<T> = React.Dispatch<React.SetStateAction<T>>;

/** State declared in App (shared with session navigation, hydration, checkpoint, Escape). */
export interface ComposerState {
  draft: string;
  setDraft: Setter<string>;
  loadedDraft: string | undefined;
  setLoadedDraft: Setter<string | undefined>;
  attachments: Data[];
  setAttachments: Setter<Data[]>;
  attachmentPreview: Data | undefined;
  setAttachmentPreview: Setter<Data | undefined>;
  fileInput: React.RefObject<HTMLInputElement | null>;
  levels: string[];
  setLevels: Setter<string[]>;
  commands: Data[] | undefined;
  setCommands: Setter<Data[] | undefined>;
  commandsOffline: boolean;
  setCommandsOffline: Setter<boolean>;
  commandActive: number;
  setCommandActive: Setter<number>;
  contextResults: string[];
  setContextResults: Setter<string[]>;
  contextActive: number;
  setContextActive: Setter<number>;
  contextLoading: boolean;
  setContextLoading: Setter<boolean>;
  completionClosed: boolean;
  setCompletionClosed: Setter<boolean>;
  completionClosedRef: { current: boolean };
  busy: boolean;
  setBusy: Setter<boolean>;
}

export function useDraftRestored({
  state,
  setDraft,
  setAttachments,
}: {
  state: State;
  setDraft: ComposerState["setDraft"];
  setAttachments: ComposerState["setAttachments"];
}) {
  useEffect(() => {
    const restore = (event: Event) => {
      if ((event as CustomEvent).detail.sessionId === state.selected) {
        setDraft(localStorage.getItem(`suri.draft.${state.selected}`) ?? "");
        setAttachments(
          JSON.parse(
            localStorage.getItem(`suri.attachments.${state.selected}`) ?? "[]",
          ),
        );
      }
    };
    window.addEventListener("suri-draft-restored", restore);
    return () => window.removeEventListener("suri-draft-restored", restore);
  }, [state.selected]);
}

export function useComposer({
  state,
  session,
  workspace,
  projection,
  composerState,
  builtinCommands,
  builtinCommandNames,
}: {
  state: State;
  session: Data | undefined;
  workspace: Data | undefined;
  projection: { phase: string };
  composerState: ComposerState;
  builtinCommands: Data[];
  builtinCommandNames: ReadonlySet<string>;
}) {
  const {
    draft,
    setDraft,
    attachments,
    setAttachments,
    commands,
    setCommands,
    setCommandsOffline,
    setContextResults,
    setContextActive,
    setContextLoading,
    setCompletionClosed,
  } = composerState;
  const saveDraft = (text: string) => {
    setDraft(text);
    localStorage.setItem(`suri.draft.${state.selected}`, text);
  };
  useEffect(() => {
    // A retired or resumed Pi process changes which extension commands exist.
    // Never keep a live catalog after the owning runtime changes phase.
    setCommands(undefined);
    setCommandsOffline(false);
  }, [session?.id, projection.phase]);
  const slashMatch = draft.match(/^\/([^\s]*)$/);
  const slashOptions = slashMatch
    ? (commands ?? builtinCommands).filter((item) =>
        item.name.toLowerCase().includes(slashMatch[1].toLowerCase()),
      )
    : [];
  const contextMatch = draft.match(/(?:^|\s)@([^\s@]*)$/);
  useEffect(() => {
    if (
      !session ||
      !slashMatch ||
      commands !== undefined ||
      builtinCommandNames.has(slashMatch[1])
    )
      return;
    let current = true;
    void command("commands.list", {}, session.id)
      .then((result) => {
        if (!current) return;
        setCommands(result.commands ?? builtinCommands);
        setCommandsOffline(result.runtimeAvailable === false);
      })
      .catch((error) => {
        if (!current) return;
        setCommands(builtinCommands);
        report(error);
      });
    return () => {
      current = false;
    };
  }, [session?.id, Boolean(slashMatch), commands]);
  useEffect(() => {
    if (!workspace || !contextMatch) {
      setContextResults([]);
      setContextLoading(false);
      return;
    }
    let current = true;
    setContextLoading(true);
    const timer = setTimeout(() => {
      void findWorkspaceFiles(workspace.id, contextMatch[1])
        .then((paths) => {
          if (current) {
            setContextResults(paths);
            setContextActive(0);
          }
        })
        .catch(report)
        .finally(() => {
          if (current) setContextLoading(false);
        });
    }, 160);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [workspace?.id, contextMatch?.[1]]);
  const addWorkspaceContext = async (path: string) => {
    if (!session || !workspace) return;
    if (attachments.length >= 8) {
      report(Error("A message can include at most 8 attachments."));
      return;
    }
    const asset = await command(
      "attachment.workspace",
      { workspaceId: workspace.id, path },
      session.id,
    );
    const next = [
      ...attachments.filter((item) => item.id !== asset.id),
      { ...asset, name: path },
    ];
    setAttachments(next);
    localStorage.setItem(
      `suri.attachments.${state.selected}`,
      JSON.stringify(next),
    );
    if (contextMatch)
      saveDraft(draft.slice(0, contextMatch.index).replace(/\s+$/, ""));
    setContextResults([]);
    setCompletionClosed(true);
  };
  const addFiles = async (
    files: readonly File[],
    options: { imagesOnly?: boolean } = {},
  ) => {
    if (!session || files.length === 0) return;
    const imageTypes = ["image/png", "image/jpeg", "image/webp"];
    if (
      options.imagesOnly &&
      files.some((file) => !imageTypes.includes(file.type))
    ) {
      report(Error("Only PNG, JPEG and WebP screenshots are supported."));
      return;
    }
    if (attachments.length + files.length > 8) {
      report(Error("A message can include at most 8 attachments."));
      return;
    }
    const imageCount =
      attachments.filter((item) => item.mime?.startsWith("image/")).length +
      files.filter((file) => imageTypes.includes(file.type)).length;
    if (imageCount > 4) {
      report(Error("A message can include at most 4 images."));
      return;
    }
    if (
      files.some((file) =>
        imageTypes.includes(file.type)
          ? file.size > 10 * 1048576
          : file.size > 1048576,
      )
    ) {
      report(Error("An image can be at most 10 MiB; a text file, 1 MiB."));
      return;
    }
    const total =
      attachments.reduce((sum, item) => sum + Number(item.bytes ?? 0), 0) +
      files.reduce((sum, file) => sum + file.size, 0);
    if (total > 20 * 1048576) {
      report(Error("Combined attachments can be at most 20 MiB."));
      return;
    }
    const sessionId = session.id;
    const added = await Promise.all(
      files.map((file, index) => {
        if (file.name) return upload(file, sessionId);
        const extension =
          file.type === "image/jpeg"
            ? "jpg"
            : file.type === "image/webp"
              ? "webp"
              : "png";
        return upload(
          new File([file], `Screenshot ${index + 1}.${extension}`, {
            type: file.type,
            lastModified: file.lastModified,
          }),
          sessionId,
        );
      }),
    );
    const next = [...attachments, ...added];
    setAttachments(next);
    localStorage.setItem(`suri.attachments.${sessionId}`, JSON.stringify(next));
  };
  return {
    saveDraft,
    slashMatch,
    slashOptions,
    contextMatch,
    addWorkspaceContext,
    addFiles,
  };
}
