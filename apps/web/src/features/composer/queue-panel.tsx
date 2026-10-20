import React from "react";
import { type Data } from "../../../../../packages/protocol/src/index.js";
import { type initialProjection } from "../../../../../packages/protocol/src/index.js";
import { command } from "../../store.js";

export function QueuePanel({
  session,
  projection,
  act,
}: {
  session: Data;
  projection: ReturnType<typeof initialProjection>;
  act: (fn: () => Promise<unknown>) => Promise<void>;
}) {
  return (
    <>
      {projection.queue.length > 0 && (
        <section className="queue" aria-label="Queued messages">
          <div className="queue-header">
            <span>
              {projection.queue.length === 1
                ? "Queued message"
                : `${projection.queue.length} queued messages`}
            </span>
            <button
              className="queue-clear"
              onClick={() =>
                void act(() => command("queue.clear", {}, session.id))
              }
            >
              Clear all
            </button>
          </div>
          <div className="queue-items">
            {projection.queue.map((q, i) => (
              <form
                className="queued"
                key={q.queueId ?? i}
                onSubmit={(event) => {
                  event.preventDefault();
                  if (!q.queueId) return;
                  const data = new FormData(event.currentTarget);
                  void act(() =>
                    command(
                      "queue.update",
                      {
                        queueId: q.queueId,
                        mode: data.get("mode"),
                        text: data.get("text"),
                      },
                      session.id,
                    ),
                  );
                }}
              >
                <select
                  className="queued-mode"
                  name="mode"
                  defaultValue={q.mode}
                  aria-label={`Delivery mode for queued message ${i + 1}`}
                  disabled={!q.queueId}
                >
                  <option value="steer">Steer</option>
                  <option value="followUp">Follow-up</option>
                </select>
                <textarea
                  className="queued-text"
                  name="text"
                  defaultValue={q.text}
                  aria-label={`Queued message ${i + 1}`}
                  rows={1}
                  disabled={!q.queueId}
                />
                <button
                  className="queued-save"
                  type="submit"
                  aria-label="Apply queued message changes"
                  title="Apply changes"
                  disabled={!q.queueId}
                >
                  <span aria-hidden="true">↑</span>
                </button>
              </form>
            ))}
          </div>
        </section>
      )}
    </>
  );
}
