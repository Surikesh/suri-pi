import React, { useEffect, useState } from "react";
import type { ThemedToken } from "shiki/core";
import { accessibleColor, highlightCode, languageForPath } from "../../code.js";
import { fileType } from "./file-type-icon.js";
const Rich = React.lazy(() => import("../../rich.js"));

export function FileContent({
  text,
  path,
  workspaceRoot,
  line,
}: {
  text: string;
  path: string;
  workspaceRoot?: string;
  line?: number;
}) {
  const [source, setSource] = useState(Boolean(line));
  const [highlighted, setHighlighted] = useState<ThemedToken[][]>();
  const markdown = fileType(path).kind === "markdown";
  useEffect(() => {
    let active = true;
    setHighlighted(undefined);
    if (text.length < 100000)
      // Highlighting is an enhancement; on failure the plain text stays shown.
      void languageForPath(path)
        .then((language) =>
          language ? highlightCode(text, language) : undefined,
        )
        .then((lines) => {
          if (active && lines) setHighlighted(lines);
        })
        .catch(() => {});
    return () => {
      active = false;
    };
  }, [path, text]);
  return (
    <div className="file-content">
      {markdown && (
        <div className="file-view-mode" role="group" aria-label="Markdown view">
          <button aria-pressed={!source} onClick={() => setSource(false)}>
            Document
          </button>
          <button aria-pressed={source} onClick={() => setSource(true)}>
            Source
          </button>
        </div>
      )}
      {markdown && !source ? (
        <article className="file-document">
          <React.Suspense fallback={<p>Rendering document…</p>}>
            <Rich text={text} workspaceRoot={workspaceRoot} />
          </React.Suspense>
        </article>
      ) : (
        <pre className="file-source">
          {text.split("\n").map((value, index) => (
            <span
              className={`file-line${index + 1 === line ? " selected" : ""}`}
              data-line={index + 1}
              key={index}
            >
              <span className="file-line-number" aria-hidden="true">
                {index + 1}
              </span>
              {highlighted?.[index]?.length
                ? highlighted[index].map(
                    (token: ThemedToken, tokenIndex: number) => (
                      <span
                        key={tokenIndex}
                        style={{ color: accessibleColor(token.color) }}
                      >
                        {token.content}
                      </span>
                    ),
                  )
                : value}
              {"\n"}
            </span>
          ))}
        </pre>
      )}
    </div>
  );
}
