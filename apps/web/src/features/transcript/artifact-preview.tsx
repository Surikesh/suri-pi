import { useState } from "react";
import { report } from "../../store.js";

export function ArtifactPreview({ id }: { id: string }) {
  const [text, setText] = useState<string>();
  const [page, setPage] = useState(0);
  return (
    <div className="artifact-actions">
      <button
        onClick={() => {
          void fetch(`/v1/assets/${id}`)
            .then((r) => {
              if (!r.ok) throw Error("Output is unavailable");
              return r.text();
            })
            .then(setText)
            .catch(report);
        }}
      >
        Open complete output
      </button>
      <a href={`/v1/assets/${id}?download=1`} download>
        Save a copy…
      </a>
      {text !== undefined && (
        <>
          <pre>{text.slice(page * 16000, (page + 1) * 16000)}</pre>
          <button disabled={page === 0} onClick={() => setPage((p) => p - 1)}>
            Previous output page
          </button>
          <button
            disabled={(page + 1) * 16000 >= text.length}
            onClick={() => setPage((p) => p + 1)}
          >
            Next output page
          </button>
          <button
            onClick={() => {
              setText(undefined);
              setPage(0);
            }}
          >
            Close output
          </button>
        </>
      )}
    </div>
  );
}
