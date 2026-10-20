import React from "react";
import { type Data } from "../../../../../packages/protocol/src/index.js";
import { command, type State } from "../../store.js";

export function SettingsRuntime({
  state,
  session,
  running,
  act,
}: {
  state: State;
  session: Data | undefined;
  running: boolean;
  act: (fn: () => Promise<unknown>) => Promise<void>;
}) {
  return (
    <>
      <h3>Runtime compatibility</h3>
      {state.catalog.runtimes.map((r: Data) => (
        <p key={r.id}>
          Pi {r.version} · {r.status}
          {session && session.runtimeId !== r.id && (
            <button
              disabled={running || r.status !== "verified"}
              onClick={() =>
                void act(() =>
                  command(
                    "session.runtime",
                    { runtimeId: r.id },
                    session.id,
                    session.revision,
                  ),
                )
              }
            >
              Use for this session
            </button>
          )}
        </p>
      ))}
      {!state.catalog.runtimes.length && (
        <p>Register a runtime using the local CLI.</p>
      )}
      <p className="muted">
        Idle Pi processes close automatically after 15 minutes; history is kept.
        New sessions: Control + Option + N (Ctrl + Alt + N).
      </p>
      <p className="muted">
        UI build ·{" "}
        {location.pathname.split("/")[1] === "ui"
          ? location.pathname.split("/")[2]
          : "bundled"}
      </p>
      <button
        onClick={() => {
          if (window.suriUpdate) {
            void act(() => window.suriUpdate!.reload());
            return;
          }
          if (window.webkit) {
            // The native shell owns draft flushing, build activation and
            // reauthentication. Delegating the whole operation avoids a
            // half-reloaded WebView with an expired host credential.
            window.webkit.messageHandlers.suri.postMessage({
              type: "reload",
            });
            return;
          }
          void act(async () => {
            await window.suriFlush?.();
            const builds = await command("ui.builds");
            if (builds.ready) {
              const result = await command("ui.activate", {
                buildId: builds.ready,
              });
              location.assign(result.url);
            } else location.reload();
          });
        }}
      >
        Reload UI
      </button>
    </>
  );
}
