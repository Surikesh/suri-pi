import React from "react";
import type { ModelCatalog } from "../../model-search.js";
import { type Data } from "../../../../../packages/protocol/src/index.js";
import { report } from "../../store.js";
import { type State } from "../../store.js";
import { AttachmentChips } from "./attachment-chips.js";
import { CompletionLists } from "./completion-lists.js";
import { ComposerControls } from "./composer-controls.js";
import { type ComposerState } from "./use-composer.js";

export function Composer({
  state,
  session,
  projection,
  running,
  queueable,
  editor,
  act,
  send,
  saveDraft,
  addFiles,
  addWorkspaceContext,
  slashMatch,
  slashOptions,
  contextMatch,
  modelOpenSignal,
  thinkingOpenSignal,
  catalogIdentity,
  catalog,
  catalogKey,
  models,
  prefetchFailure,
  prefs,
  loadModels,
  composerState,
  builtinCommands,
  builtinCommandNames,
}: {
  state: State;
  session: Data;
  projection: Data;
  running: boolean;
  queueable: boolean;
  editor: { current: HTMLTextAreaElement | null };
  act: (fn: () => Promise<unknown>) => Promise<void>;
  send: (deliveryMode?: "steer" | "followUp") => Promise<void>;
  saveDraft: (text: string) => void;
  addFiles: (
    files: readonly File[],
    options?: { imagesOnly?: boolean },
  ) => Promise<void>;
  addWorkspaceContext: (path: string) => Promise<void>;
  slashMatch: RegExpMatchArray | null;
  slashOptions: Data[];
  contextMatch: RegExpMatchArray | null;
  modelOpenSignal: number;
  thinkingOpenSignal: number;
  catalogIdentity: string;
  catalog: { current: ModelCatalog };
  catalogKey: (session: Data) => string;
  models: Data[];
  prefetchFailure: { identity: string; message: string } | undefined;
  prefs: Data;
  loadModels: (session: Data, force?: boolean) => Promise<unknown>;
  composerState: ComposerState;
  builtinCommands: Data[];
  builtinCommandNames: ReadonlySet<string>;
}) {
  const {
    draft,
    fileInput,
    commandActive,
    setCommandActive,
    contextResults,
    contextActive,
    setContextActive,
    setCompletionClosed,
    completionClosedRef,
  } = composerState;
  return (
    <div className="composer">
      <AttachmentChips state={state} composerState={composerState} />
      <input
        hidden
        type="file"
        ref={fileInput}
        accept="image/png,image/jpeg,image/webp,text/*,.md,.ts,.json"
        multiple
        onChange={(e) => {
          const input = e.currentTarget;
          const files = Array.from(input.files ?? []);
          void act(() => addFiles(files)).finally(() => {
            input.value = "";
          });
        }}
      />
      <textarea
        ref={editor}
        aria-label="Message Pi"
        placeholder={session ? "Message Pi…" : "Select a session to begin"}
        disabled={!session}
        value={draft}
        onChange={(e) => {
          completionClosedRef.current = false;
          setCompletionClosed(false);
          setCommandActive(0);
          setContextActive(0);
          saveDraft(e.target.value);
        }}
        onPaste={(e) => {
          const itemFiles = Array.from(e.clipboardData.items)
            .filter((item) => item.kind === "file")
            .map((item) => item.getAsFile())
            .filter((file): file is File => file !== null);
          const files = itemFiles.length
            ? itemFiles
            : Array.from(e.clipboardData.files);
          if (files.length === 0) return;
          e.preventDefault();
          const text = e.clipboardData.getData("text/plain");
          if (text) {
            const target = e.currentTarget;
            const start = target.selectionStart;
            const end = target.selectionEnd;
            const current = target.value;
            const next = current.slice(0, start) + text + current.slice(end);
            saveDraft(next);
            requestAnimationFrame(() => {
              const caret = start + text.length;
              target.setSelectionRange(caret, caret);
            });
          }
          void addFiles(files, { imagesOnly: true }).catch(report);
        }}
        onKeyDown={(e) => {
          const currentValue = e.currentTarget.value;
          const slashOpen =
            !completionClosedRef.current &&
            Boolean(currentValue.match(/^\/([^\s]*)$/));
          const contextOpen =
            !completionClosedRef.current &&
            Boolean(currentValue.match(/(?:^|\s)@([^\s@]*)$/));
          if (slashOpen || contextOpen) {
            const options = slashOpen ? slashOptions : contextResults;
            const active = slashOpen ? commandActive : contextActive;
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault();
              if (!options.length) return;
              const next =
                (active + (e.key === "ArrowDown" ? 1 : -1) + options.length) %
                options.length;
              if (slashOpen) setCommandActive(next);
              else setContextActive(next);
              return;
            }
            if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              completionClosedRef.current = true;
              setCompletionClosed(true);
              return;
            }
            if (e.key === "Enter" && !e.nativeEvent.isComposing) {
              e.preventDefault();
              if (slashOpen && slashOptions[active]) {
                const selected = slashOptions[active];
                completionClosedRef.current = true;
                setCompletionClosed(true);
                if (
                  draft === `/${selected.name}` &&
                  builtinCommandNames.has(selected.name)
                )
                  void send();
                else saveDraft(`/${selected.name} `);
              } else if (contextResults[active])
                void addWorkspaceContext(contextResults[active]).catch(report);
              return;
            }
          }
          if (
            e.key === "Tab" &&
            !e.shiftKey &&
            !e.altKey &&
            !e.ctrlKey &&
            !e.metaKey
          ) {
            const modelButton = document.querySelector<HTMLButtonElement>(
              ".composer .model-search-picker > button:not(:disabled)",
            );
            if (modelButton) {
              e.preventDefault();
              modelButton.focus();
              return;
            }
          }
          if (
            e.key === "Enter" &&
            !e.nativeEvent.isComposing &&
            (!e.shiftKey || e.metaKey)
          ) {
            e.preventDefault();
            void send(queueable && e.metaKey ? "steer" : undefined);
          }
        }}
      />
      <CompletionLists
        session={session}
        running={running}
        editor={editor}
        act={act}
        slashMatch={slashMatch}
        slashOptions={slashOptions}
        contextMatch={contextMatch}
        saveDraft={saveDraft}
        addWorkspaceContext={addWorkspaceContext}
        composerState={composerState}
        builtinCommands={builtinCommands}
      />
      <ComposerControls
        state={state}
        session={session}
        projection={projection}
        running={running}
        queueable={queueable}
        act={act}
        send={send}
        modelOpenSignal={modelOpenSignal}
        thinkingOpenSignal={thinkingOpenSignal}
        catalogIdentity={catalogIdentity}
        catalog={catalog}
        catalogKey={catalogKey}
        models={models}
        prefetchFailure={prefetchFailure}
        prefs={prefs}
        loadModels={loadModels}
        composerState={composerState}
      />
    </div>
  );
}
