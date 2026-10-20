import React from "react";
import { type Data } from "../../../../../packages/protocol/src/index.js";
import { ActionError } from "../../components/ui.js";
import { command, dismiss, type State } from "../../store.js";

export function ComposerStatus({
  state,
  session,
  projection,
  settings,
  sessionMenu,
  projectMenu,
  act,
}: {
  state: State;
  session: Data | undefined;
  projection: Data;
  settings: boolean;
  sessionMenu: unknown;
  projectMenu: unknown;
  act: (fn: () => Promise<unknown>) => Promise<void>;
}) {
  return (
    <>
      {!settings && !sessionMenu && !projectMenu && (
        <ActionError message={state.error} onDismiss={dismiss} />
      )}
      <div className="run-status" aria-live="polite">
        {session
          ? `${projection.phase}${projection.outcome ? " · " + projection.outcome : ""}`
          : ""}
        {session && ["failed", "interrupted"].includes(projection.phase) && (
          <button
            type="button"
            onClick={() =>
              void act(() => command("session.resume", {}, session.id))
            }
          >
            Retry startup
          </button>
        )}
      </div>
    </>
  );
}
