import { useEffect } from "react";
import type { Data } from "../../../../packages/protocol/src/index.js";
import {
  command,
  report,
  select,
  viewDraftRevision,
  type State,
} from "../store.js";
import { viewStorage as localStorage } from "../view-storage.js";
import { mergeTranscriptMessages } from "../domain/presentation.js";
import type {
  ComposerStateValue,
  DialogState,
  HistoryState,
  ShellState,
} from "./use-app-state.js";
import type { SessionView } from "./use-session-view.js";

export function useUpdateBridge({
  state,
  session,
  workspace,
  shell,
  dialogs,
  history,
  composerState,
}: {
  state: State;
  session: SessionView["session"];
  workspace: SessionView["workspace"];
  shell: ShellState;
  dialogs: DialogState;
  history: HistoryState;
  composerState: ComposerStateValue;
}) {
  const { sidebar, setSidebar, details, setDetails, editor } = shell;
  const { setSettings, setImportPreview } = dialogs;
  const { setOlder, setHistoryCursor } = history;
  const { draft, setDraft, attachments, setAttachments, loadedDraft } =
    composerState;
  useEffect(() => {
    if (!window.suriUpdate) return;
    window.suriViewReady = () => !session || loadedDraft === session.id;
    window.suriCheckpoint = () => {
      const scroller = document.querySelector(
        ".transcript",
      ) as HTMLElement | null;
      const top = scroller?.getBoundingClientRect().top ?? 0;
      const anchor = [
        ...document.querySelectorAll<HTMLElement>("[data-transcript-id]"),
      ].find((node) => node.getBoundingClientRect().bottom > top);
      return {
        schema: 1,
        selectedProjectId: workspace?.projectId ?? null,
        selectedWorkspaceId: workspace?.id ?? null,
        selectedSessionId: session?.id ?? null,
        draft: {
          text: draft,
          attachmentIds: attachments.map((item) => item.id),
          revision: viewDraftRevision(session?.id ?? ""),
          outboxIds: localStorage
            .keys()
            .filter((key) => key.startsWith("suri.outbox."))
            .map((key) => key.slice("suri.outbox.".length))
            .slice(0, 1000),
        },
        expandedIds: [
          ...document.querySelectorAll<HTMLElement>(
            "details[open][data-disclosure-id]",
          ),
        ]
          .map((node) => node.dataset.disclosureId!)
          .slice(0, 10000),
        anchor: {
          messageId: anchor?.dataset.transcriptId ?? null,
          blockId: null,
          offset: anchor ? anchor.getBoundingClientRect().top - top : 0,
          bottomFollow:
            !scroller ||
            scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <
              64,
        },
        layout: {
          sidebarOpen: sidebar,
          detailsOpen: details,
          focus:
            document.activeElement === editor.current ? "composer" : "none",
        },
      };
    };
    window.suriWatermarks = () => ({
      catalogSeq: Number(state.catalog.seq ?? 0),
      ...(state.selected
        ? { sessionSeq: Number(state.projections[state.selected]?.seq ?? 0) }
        : {}),
    });
    window.suriRestore = async (checkpoint) => {
      if (!checkpoint) return;
      if (
        checkpoint.selectedSessionId &&
        !state.catalog.sessions.some(
          (item: Data) => item.id === checkpoint.selectedSessionId,
        )
      ) {
        report(
          Error(
            "The selected session is no longer available. Its draft remains in this window's saved state; download it from Updates before closing this window.",
          ),
        );
        return;
      }
      if (checkpoint.draft.outboxIds.length)
        report(
          Error(
            "A message delivery is still unconfirmed. Inspect this session before sending again; no message was resubmitted.",
          ),
        );
      if (
        checkpoint.selectedSessionId &&
        state.selected !== checkpoint.selectedSessionId
      ) {
        select(checkpoint.selectedSessionId);
        return;
      }
      setDraft(checkpoint.draft.text);
      setAttachments((current) =>
        checkpoint.draft.attachmentIds.map(
          (id) =>
            current.find((item) => item.id === id) ?? {
              id,
              name: "Retained attachment",
            },
        ),
      );
      setSidebar(checkpoint.layout.sidebarOpen);
      setDetails(checkpoint.layout.detailsOpen);
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      );
      const scroller = document.querySelector(
        ".transcript",
      ) as HTMLElement | null;
      if (scroller) {
        if (checkpoint.anchor.bottomFollow)
          scroller.scrollTop = scroller.scrollHeight;
        else if (checkpoint.anchor.messageId) {
          let anchor = document.querySelector<HTMLElement>(
            `[data-transcript-id="${CSS.escape(checkpoint.anchor.messageId)}"]`,
          );
          let cursor: number | undefined;
          for (
            let page = 0;
            !anchor && page < 20 && checkpoint.selectedSessionId;
            page++
          ) {
            const history = await command(
              "session.history",
              { before: cursor, limit: 200 },
              checkpoint.selectedSessionId,
            );
            setOlder((current) =>
              mergeTranscriptMessages(history.messages ?? [], current),
            );
            setHistoryCursor(history.cursor ?? null);
            await new Promise<void>((resolve) =>
              requestAnimationFrame(() =>
                requestAnimationFrame(() => resolve()),
              ),
            );
            anchor = document.querySelector<HTMLElement>(
              `[data-transcript-id="${CSS.escape(checkpoint.anchor.messageId)}"]`,
            );
            if (history.cursor === null || history.cursor === undefined) break;
            cursor = history.cursor;
          }
          if (!anchor)
            report(
              Error(
                "Could not restore the saved scroll position within the history limit. Your draft was restored.",
              ),
            );
          if (anchor)
            scroller.scrollTop +=
              anchor.getBoundingClientRect().top -
              scroller.getBoundingClientRect().top -
              checkpoint.anchor.offset;
        }
      }
      for (const id of checkpoint.expandedIds) {
        const disclosure = document.querySelector<HTMLDetailsElement>(
          `details[data-disclosure-id="${CSS.escape(id)}"]`,
        );
        if (disclosure) disclosure.open = true;
      }
      if (checkpoint.layout.focus === "composer") editor.current?.focus();
    };
    const checkpointWritable = () =>
      window.suriUpdate?.ready &&
      document.documentElement.dataset.suriUpdating !== "true";
    const save = () => {
      if (!checkpointWritable()) return;
      if (loadedDraft === session?.id || !session)
        sessionStorage.setItem(
          "suri.checkpoint",
          JSON.stringify(window.suriCheckpoint?.()),
        );
    };
    let persist: ReturnType<typeof setTimeout>;
    const changed = () => {
      if (!checkpointWritable()) return;
      save();
      clearTimeout(persist);
      persist = setTimeout(() => {
        if (checkpointWritable() && (loadedDraft === session?.id || !session))
          void window.suriUpdate
            ?.persist(window.suriCheckpoint!())
            .catch(report);
      }, 250);
    };
    changed();
    addEventListener("pagehide", save);
    addEventListener("suri-update-ready", changed);
    document.addEventListener("toggle", changed, true);
    document.addEventListener("scroll", changed, true);
    return () => {
      clearTimeout(persist);
      removeEventListener("pagehide", save);
      removeEventListener("suri-update-ready", changed);
      document.removeEventListener("toggle", changed, true);
      document.removeEventListener("scroll", changed, true);
    };
  }, [
    session,
    workspace,
    draft,
    attachments,
    sidebar,
    details,
    loadedDraft,
    state,
  ]);
  useEffect(() => {
    window.suriImportFiles = async (files) => {
      if (!session) throw Error("Select a destination session first.");
      const result = await command("session.importPreview", {
        fileGrantIds: files.map((file) => file.grantId),
        workspaceId: session.workspaceId,
      });
      setImportPreview(
        (result.candidates ?? []).map((candidate: Data) => ({
          ...candidate,
          selected: candidate.status === "ready",
        })),
      );
      setSettings(true);
    };
    return () => {
      delete window.suriImportFiles;
    };
  }, [session?.id]);
}
