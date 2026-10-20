import React, { useEffect, useRef, useState } from "react";
import type { ThemedToken } from "shiki/core";
import { accessibleColor, highlightCode, languageForPath } from "../../code.js";

export function HighlightedTextarea({
  path,
  value,
  onChange,
  onKeyDown,
  textareaRef,
}: {
  path: string;
  value: string;
  onChange: (value: string) => void;
  onKeyDown?: React.KeyboardEventHandler<HTMLTextAreaElement>;
  textareaRef?: React.RefObject<HTMLTextAreaElement | null>;
}) {
  const [lines, setLines] = useState<ThemedToken[][]>();
  const highlight = useRef<HTMLPreElement>(null);
  useEffect(() => {
    let active = true;
    const timer = window.setTimeout(() => {
      // Highlighting is an enhancement; on failure the plain text stays shown.
      void languageForPath(path)
        .then((language) =>
          language && value.length < 100000
            ? highlightCode(value, language)
            : undefined,
        )
        .then((next) => {
          if (active) setLines(next);
        })
        .catch(() => {});
    }, 60);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [path, value]);
  return (
    <div className="highlighted-textarea">
      <pre ref={highlight} aria-hidden="true">
        {value.split("\n").map((text, index) => (
          <span className="file-line" key={index}>
            {lines?.[index]?.length
              ? lines[index].map((token: ThemedToken, tokenIndex: number) => (
                  <span
                    key={tokenIndex}
                    style={{ color: accessibleColor(token.color) }}
                  >
                    {token.content}
                  </span>
                ))
              : text}
            {"\n"}
          </span>
        ))}
      </pre>
      <textarea
        ref={textareaRef}
        aria-label={`Edit ${path}`}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={onKeyDown}
        onScroll={(event) => {
          if (highlight.current) {
            highlight.current.scrollTop = event.currentTarget.scrollTop;
            highlight.current.scrollLeft = event.currentTarget.scrollLeft;
          }
        }}
        spellCheck={false}
      />
    </div>
  );
}
