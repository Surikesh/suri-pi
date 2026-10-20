import { useEffect } from "react";
import { type Data } from "../../../../../packages/protocol/src/index.js";
import { command, refresh, report, store, type State } from "../../store.js";
import { viewStorage as localStorage } from "../../view-storage.js";
import { type ComposerState } from "./use-composer.js";

export function useSend({
  state,
  session,
  running,
  queueable,
  editor,
  runBuiltin,
  saveDraft,
  composerState,
  builtinCommandNames,
}: {
  state: State;
  session: Data | undefined;
  running: boolean;
  queueable: boolean;
  editor: { current: HTMLTextAreaElement | null };
  runBuiltin: (name: string, argument: string) => Promise<unknown>;
  saveDraft: (text: string) => void;
  composerState: ComposerState;
  builtinCommandNames: ReadonlySet<string>;
}) {
  const {
    draft,
    setDraft,
    loadedDraft,
    attachments,
    setAttachments,
    commands,
    busy,
    setBusy,
  } = composerState;
  const send = async (deliveryMode?: "steer" | "followUp") => {
    const text = editor.current?.value ?? draft;
    if (!text.trim() || (busy && !running)) return;
    const slashName = text.match(/^\/([^\s]+)/)?.[1];
    if (slashName && builtinCommandNames.has(slashName)) {
      const draftStorageKey = `suri.draft.${state.selected}`;
      setBusy(true);
      if (slashName === "compact") saveDraft("");
      try {
        await runBuiltin(slashName, text.slice(slashName.length + 1).trim());
        if (localStorage.getItem(draftStorageKey) === text) saveDraft("");
        // UI-only built-ins become ready when their surface is visible; do not
        // silently drop the next keyboard command while catalog refresh settles.
        setBusy(false);
        await refresh();
      } catch (error) {
        report(error);
      } finally {
        setBusy(false);
        if (
          !document.querySelector(
            '[role="dialog"], .picker-menu, .session-menu',
          ) &&
          ![
            "model",
            "thinking",
            "settings",
            "scoped-models",
            "tree",
            "fork",
            "name",
            "resume",
            "hotkeys",
            "changelog",
            "session",
            "import",
            "next-session",
            "new",
          ].includes(slashName ?? "")
        )
          editor.current?.focus();
      }
      return;
    }
    if (!session) return;
    if (slashName) {
      try {
        const catalog =
          commands ??
          (await command("commands.list", {}, session.id)).commands ??
          [];
        if (
          !catalog.some(
            (item: Data) =>
              item.name === slashName && item.source !== "builtin",
          )
        ) {
          report(
            Error(`Unknown command /${slashName}. It was not sent to Pi.`),
          );
          return;
        }
      } catch (error) {
        report(error);
        return;
      }
    }
    const immediateExtension =
      running &&
      commands?.some(
        (item) => item.name === slashName && item.source === "extension",
      );
    if (running && !queueable && !immediateExtension) {
      report(Error("Wait for Pi to finish compacting or stopping."));
      return;
    }
    setBusy(true);
    try {
      await command(
        "run.submit",
        {
          mode: immediateExtension
            ? "prompt"
            : queueable
              ? (deliveryMode ?? "followUp")
              : "prompt",
          text,
          attachmentIds: attachments.map((a) => a.id),
          ...(immediateExtension ? { immediateExtension: true } : {}),
        },
        session.id,
      );
      // A receipt must not erase text or files edited while submission was pending.
      const draftKey = `suri.draft.${session.id}`;
      if (localStorage.getItem(draftKey) === text) {
        localStorage.setItem(draftKey, "");
        if (store.getSnapshot().selected === session.id) setDraft("");
      }
      const attachmentKey = `suri.attachments.${session.id}`;
      const submittedIds = new Set(attachments.map((a) => a.id));
      const remaining = JSON.parse(
        localStorage.getItem(attachmentKey) ?? "[]",
      ).filter((a: Data) => !submittedIds.has(a.id));
      localStorage.setItem(attachmentKey, JSON.stringify(remaining));
      if (store.getSnapshot().selected === session.id)
        setAttachments(remaining);
    } catch (e) {
      report(e);
    } finally {
      setBusy(false);
      if (
        !document.querySelector(
          '[role="dialog"], .picker-menu, .session-menu',
        ) &&
        ![
          "model",
          "thinking",
          "settings",
          "scoped-models",
          "tree",
          "fork",
          "name",
          "resume",
          "hotkeys",
          "changelog",
          "session",
          "import",
        ].includes(slashName ?? "")
      )
        editor.current?.focus();
    }
  };
  useEffect(() => {
    window.suriFlush = async () => {
      if (session && loadedDraft === session.id)
        await command(
          "draft.save",
          { text: draft, attachmentIds: attachments.map((a) => a.id) },
          session.id,
        );
    };
    const timer = setTimeout(() => {
      // The explicit checkpoint flush drains the serialized write queue. Do not
      // start another autosave after the window has acknowledged a handoff.
      if (document.documentElement.dataset.suriUpdating !== "true")
        void window.suriFlush?.().catch(report);
    }, 300);
    return () => {
      clearTimeout(timer);
      delete window.suriFlush;
    };
  }, [session, draft, attachments, loadedDraft]);
  return { send };
}
