import React from "react";
import type { ModelCatalog } from "../../model-search.js";
import { type Data } from "../../../../../packages/protocol/src/index.js";
import { Icon, Picker } from "../../components/ui.js";
import { ModelSearchPicker } from "../../components/model-search-picker.js";
import { command, store, type State } from "../../store.js";
import { type ComposerState } from "./use-composer.js";

export function ComposerControls({
  state,
  session,
  projection,
  running,
  queueable,
  act,
  send,
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
}: {
  state: State;
  session: Data;
  projection: Data;
  running: boolean;
  queueable: boolean;
  act: (fn: () => Promise<unknown>) => Promise<void>;
  send: (deliveryMode?: "steer" | "followUp") => Promise<void>;
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
}) {
  const { draft, fileInput, levels, setLevels, busy } = composerState;
  return (
    <>
      <div className="composer-controls">
        <div className="send-controls">
          {session && (
            <ModelSearchPicker
              key={`model:${catalogIdentity}`}
              openSignal={modelOpenSignal}
              sessionId={session.id}
              selected={
                session.model
                  ? `${session.model.provider}/${session.model.id}`
                  : undefined
              }
              display={session.model?.id ?? "Choose model"}
              disabled={running && projection.phase !== "starting"}
              starting={projection.phase === "starting"}
              models={models}
              cached={catalog.current.get(catalogKey(session)) !== undefined}
              prefetchError={
                prefetchFailure?.identity === catalogIdentity
                  ? prefetchFailure.message
                  : undefined
              }
              scope={
                Array.isArray(prefs.values.scopedModels)
                  ? prefs.values.scopedModels
                  : null
              }
              load={async (refresh) => {
                await loadModels(session, refresh);
              }}
              choose={async (m) => {
                try {
                  await command(
                    "model.set",
                    { provider: m.provider, id: m.id },
                    session.id,
                    store
                      .getSnapshot()
                      .catalog.sessions.find(
                        (item: Data) => item.id === session.id,
                      )?.revision ?? session.revision,
                  );
                } catch (error) {
                  catalog.current.invalidate(
                    `${session.id}:${session.workspaceId}:${session.runtimeId ?? session.runtime ?? ""}`,
                  );
                  throw error;
                }
              }}
            />
          )}
          <div className="model-controls">
            <button
              className="composer-round-action"
              aria-label="Attach file"
              disabled={!session}
              onClick={() => fileInput.current?.click()}
            >
              <Icon name="attach" />
            </button>
          </div>
          {session && (
            <Picker
              key={`thinking:${session.id}`}
              openSignal={thinkingOpenSignal}
              label="Thinking level"
              display={session.thinkingLevel ?? "Thinking"}
              disabled={running}
              items={levels.map((level) => ({ level }))}
              itemKey={(item) => item.level}
              itemLabel={(item) => item.level}
              load={async () =>
                setLevels(
                  (await command("thinking.list", {}, session.id)).levels ?? [],
                )
              }
              choose={async (item) =>
                act(() =>
                  command(
                    "thinking.set",
                    { level: item.level },
                    session.id,
                    session.revision,
                  ),
                )
              }
            />
          )}
          {running && projection.phase !== "starting" && (
            <button
              className="stop"
              aria-label="Stop run"
              onClick={() =>
                void act(() => command("run.cancel", {}, session.id))
              }
            >
              <Icon name="stop" />
            </button>
          )}
          {(!queueable || projection.phase === "starting") && (
            <button
              className="send"
              aria-label="Send message"
              disabled={
                !session || !draft.trim() || !state.connected || busy || running
              }
              onClick={() => void send()}
            >
              <Icon name="send" />
            </button>
          )}
        </div>
      </div>
    </>
  );
}
