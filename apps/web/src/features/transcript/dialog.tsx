import { useState } from "react";
import { type Data } from "../../../../../packages/protocol/src/index.js";
import { command, report } from "../../store.js";

export function Dialog({ item, sessionId }: { item: Data; sessionId: string }) {
  const [value, setValue] = useState(item.prefill ?? "");
  const send = (answer: Data) =>
    void command(
      "interaction.respond",
      { interactionId: item.interactionId, answer },
      sessionId,
    ).catch(report);
  return (
    <div className="modal-backdrop">
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="question-title"
        className="modal"
      >
        <h2 id="question-title">{item.title || "Pi needs your input"}</h2>
        <p>{item.message}</p>
        {item.method === "select" ? (
          <select
            aria-label="Answer"
            value={value}
            onChange={(e) => setValue(e.target.value)}
          >
            <option value="">Choose…</option>
            {item.options.map((o: string) => (
              <option key={o}>{o}</option>
            ))}
          </select>
        ) : item.method !== "confirm" ? (
          <textarea
            aria-label="Answer"
            autoFocus
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
        ) : null}
        <div className="actions">
          <button onClick={() => send({ cancelled: true })}>Cancel</button>
          <button
            className="primary"
            onClick={() =>
              send(item.method === "confirm" ? { confirmed: true } : { value })
            }
          >
            {item.method === "confirm" ? "Confirm" : "Submit"}
          </button>
        </div>
      </section>
    </div>
  );
}
