import React from "react";
import { type Data } from "../../../../../packages/protocol/src/index.js";
import { Icon } from "../../components/ui.js";
import { command, report } from "../../store.js";
import { type ComposerState } from "./use-composer.js";

export function CompletionLists({
  session,
  running,
  editor,
  act,
  slashMatch,
  slashOptions,
  contextMatch,
  saveDraft,
  addWorkspaceContext,
  composerState,
  builtinCommands,
}: {
  session: Data | undefined;
  running: boolean;
  editor: { current: HTMLTextAreaElement | null };
  act: (fn: () => Promise<unknown>) => Promise<void>;
  slashMatch: RegExpMatchArray | null;
  slashOptions: Data[];
  contextMatch: RegExpMatchArray | null;
  saveDraft: (text: string) => void;
  addWorkspaceContext: (path: string) => Promise<void>;
  composerState: ComposerState;
  builtinCommands: Data[];
}) {
  const {
    commands,
    setCommands,
    commandsOffline,
    setCommandsOffline,
    commandActive,
    setCommandActive,
    contextResults,
    contextActive,
    setContextActive,
    contextLoading,
    completionClosed,
    setCompletionClosed,
  } = composerState;
  return (
    <>
      {!completionClosed && slashMatch && (
        <div className="completion" role="listbox" aria-label="Slash commands">
          {commands === undefined && slashOptions.length === 0 ? (
            <span>Loading commands…</span>
          ) : slashOptions.length === 0 ? (
            <span>No supported Pi command matches.</span>
          ) : (
            slashOptions.map((item, index) => (
              <button
                role="option"
                aria-selected={index === commandActive}
                key={item.name}
                onMouseEnter={() => setCommandActive(index)}
                onClick={() => {
                  saveDraft(`/${item.name} `);
                  setCompletionClosed(true);
                  editor.current?.focus();
                }}
              >
                <strong>/{item.name}</strong>
                <span>{item.description || "No description"}</span>
                <small>{item.source}</small>
              </button>
            ))
          )}
          {commandsOffline && session && (
            <button
              type="button"
              onClick={() =>
                void act(async () => {
                  await command("session.resume", {}, session.id);
                  const result = await command("commands.list", {}, session.id);
                  setCommands(result.commands ?? builtinCommands);
                  setCommandsOffline(result.runtimeAvailable === false);
                  editor.current?.focus();
                })
              }
            >
              Resume session to load Pi commands
            </button>
          )}
          {running &&
            slashOptions.some((item) => item.source === "extension") && (
              <p>Extension commands run immediately during a response.</p>
            )}
        </div>
      )}
      {!completionClosed && contextMatch && (
        <div className="completion" role="listbox" aria-label="Workspace files">
          {contextLoading ? (
            <span>Searching workspace…</span>
          ) : contextResults.length === 0 ? (
            <span>No supported text file matches.</span>
          ) : (
            contextResults.map((path, index) => (
              <button
                role="option"
                aria-selected={index === contextActive}
                key={path}
                onMouseEnter={() => setContextActive(index)}
                onClick={() => void addWorkspaceContext(path).catch(report)}
              >
                <Icon name="file" />
                <span>{path}</span>
              </button>
            ))
          )}
        </div>
      )}
    </>
  );
}
