import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { parseDiff } from "./change-review.js";
import { accessibleColor, highlightCode, languageForPath } from "./code.js";
import type { Data } from "../../../packages/protocol/src/index.js";

type Token = { content: string; color?: string };
const imageMimes: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
};
function formatBytes(bytes?: number, truncated = false) {
  if (!Number.isFinite(bytes)) return "Size unavailable";
  const value = Number(bytes);
  const units = ["B", "KB", "MB"];
  let amount = value;
  let unit = 0;
  while (amount >= 1024 && unit < units.length - 1) {
    amount /= 1024;
    unit++;
  }
  return `${truncated ? "at least " : ""}${amount >= 10 || unit === 0 ? amount.toFixed(0) : amount.toFixed(1)} ${units[unit]}`;
}

export function BinaryPreview({
  path,
  file,
  error,
}: {
  path: string;
  file?: Data;
  error?: string;
}) {
  const extension = path.split(".").at(-1)?.toLowerCase() ?? "";
  const mime = imageMimes[extension];
  const [url, setUrl] = useState("");
  const [dimensions, setDimensions] = useState("");
  useEffect(() => {
    setDimensions("");
    if (!mime || file?.encoding !== "base64" || file.truncated) {
      setUrl("");
      return;
    }
    const bytes = Uint8Array.from(atob(file.content), (value) =>
      value.charCodeAt(0),
    );
    const next = URL.createObjectURL(new Blob([bytes], { type: mime }));
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [file, mime]);
  const format = extension ? extension.toUpperCase() : "Binary";
  if (url)
    return (
      <figure className="binary-image-preview">
        <div className="binary-image-canvas">
          <img
            src={url}
            alt={`Preview of ${path}`}
            onLoad={(event) =>
              setDimensions(
                `${event.currentTarget.naturalWidth} × ${event.currentTarget.naturalHeight}`,
              )
            }
          />
        </div>
        <figcaption>
          <strong>Current workspace file</strong>
          <span>
            {[format, formatBytes(file?.bytes), dimensions]
              .filter(Boolean)
              .join(" · ")}
          </span>
        </figcaption>
      </figure>
    );
  const image = Boolean(mime);
  return (
    <section className="binary-file-state" aria-label="Binary file details">
      <strong>{image ? "Image preview unavailable" : "Binary file"}</strong>
      <span>
        {format} · {formatBytes(file?.bytes, Boolean(file?.truncated))}
      </span>
      <small>
        {file?.truncated
          ? "The file exceeds the preview limit. Use Open to inspect the complete file."
          : error
            ? "The current workspace file is unavailable. It may have been deleted or renamed."
            : "Text review is unavailable. Use Open or Open With… to inspect this file."}
      </small>
    </section>
  );
}
export function DiffPreview({
  text,
  path,
  label,
}: {
  text: string;
  path: string;
  label: string;
}) {
  const rows = useMemo(() => parseDiff(text), [text]);
  const [highlight, setHighlight] = useState<{
    text: string;
    path: string;
    tokens: Token[][];
  }>();
  useEffect(() => {
    let active = true;
    if (text.length < 100000)
      void languageForPath(path)
        .then(async (language) => {
          if (!language) return undefined;
          // Tokenize each side separately so removed lines cannot corrupt new-side grammar.
          const tokens: Token[][] = rows.map(() => []);
          for (const side of ["old", "new"] as const) {
            const indices = rows.flatMap((row, i) =>
              row[side] !== undefined ? [i] : [],
            );
            const highlighted = await highlightCode(
              indices.map((i) => rows[i].text).join("\n"),
              language,
            );
            indices.forEach((index, i) => {
              tokens[index] = highlighted[i];
            });
          }
          return tokens;
        })
        .then((tokens) => {
          if (active && tokens) setHighlight({ text, path, tokens });
        })
        .catch(() => {});
    return () => {
      active = false;
    };
  }, [rows, text, path]);
  if (!text) return null;
  if (!rows.some((row) => row.old !== undefined || row.new !== undefined))
    return (
      <p className="file-state">
        {/binary/i.test(text)
          ? "Binary file · text review unavailable."
          : text.includes("new file mode")
            ? "Empty file · no text lines to review."
            : "No textual changes in this section (the file may be renamed or have metadata-only changes)."}
      </p>
    );
  return (
    <section className="diff-section" aria-label={`${label} patch`}>
      <h3>{label}</h3>
      <div
        className="diff-preview"
        tabIndex={0}
        aria-label={`${label} source`}
        style={
          {
            "--diff-gutter": `${rows.reduce((digits, row) => Math.max(digits, String(row.old ?? 0).length, String(row.new ?? 0).length), 3) + 2}ch`,
          } as CSSProperties
        }
      >
        {rows.map((row, i) => (
          <div className={`diff-line ${row.kind}`} key={i}>
            {row.kind === "hunk" || row.kind === "note" ? (
              <span className="diff-separator">{row.text}</span>
            ) : (
              <>
                <span
                  className="diff-number"
                  aria-label={
                    row.old === undefined ? undefined : `Old line ${row.old}`
                  }
                >
                  {row.old ?? ""}
                </span>
                <span
                  className="diff-number"
                  aria-label={
                    row.new === undefined ? undefined : `New line ${row.new}`
                  }
                >
                  {row.new ?? ""}
                </span>
                <span className="diff-marker" aria-hidden="true">
                  {row.kind === "add" ? "+" : row.kind === "remove" ? "−" : " "}
                </span>
                <code>
                  {highlight?.text === text &&
                  highlight.path === path &&
                  highlight.tokens[i]?.length
                    ? highlight.tokens[i].map((token, j) => (
                        <span
                          key={j}
                          style={{ color: accessibleColor(token.color) }}
                        >
                          {token.content}
                        </span>
                      ))
                    : row.text || " "}
                </code>
              </>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}
