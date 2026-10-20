import { useEffect, useState, type ReactNode } from "react";
import type { HighlighterCore, LanguageInput, ThemedToken } from "shiki/core";
import { createHighlightQueue } from "./highlight-queue.js";
let highlighter: Promise<HighlighterCore> | undefined;
let bundledLanguages: Record<string, unknown> = {};
// Long code remains readable and copyable without blocking the main thread for
// seconds in Shiki's synchronous regex tokenizer on every session remount.
const MAX_HIGHLIGHT_CHARS = 8_000;
const MAX_HIGHLIGHT_LINES = 200;
const scheduleHighlight = createHighlightQueue(
  () =>
    new Worker(new URL("./code-worker.ts", import.meta.url), {
      type: "module",
    }),
);
async function getHighlighter() {
  highlighter ??= Promise.all([
    import("shiki/core"),
    import("shiki/engine/javascript"),
    import("shiki/langs"),
    import("shiki/themes/github-light.mjs"),
  ]).then(([core, engine, languages, theme]) => {
    bundledLanguages = languages.bundledLanguages;
    return core.createHighlighterCore({
      themes: [theme.default],
      langs: [],
      engine: engine.createJavaScriptRegexEngine(),
    });
  });
  return highlighter;
}

const filenameLanguages: Record<string, string> = {
  dockerfile: "dockerfile",
  makefile: "makefile",
  rakefile: "ruby",
  gemfile: "ruby",
  procfile: "shellscript",
};
const extensionLanguages: Record<string, string> = {
  cjs: "javascript",
  h: "c",
  hpp: "cpp",
  js: "javascript",
  jsx: "jsx",
  mdx: "mdx",
  mjs: "javascript",
  mts: "typescript",
  pyw: "python",
  rbw: "ruby",
  sh: "shellscript",
  ts: "typescript",
  tsx: "tsx",
  yml: "yaml",
};
export async function languageForPath(path: string) {
  const name = path.split("/").at(-1)?.toLowerCase() ?? "";
  const extension = name.includes(".") ? (name.split(".").at(-1) ?? "") : "";
  const requested =
    filenameLanguages[name] ?? extensionLanguages[extension] ?? extension;
  if (!requested) return undefined;
  await getHighlighter();
  return requested in bundledLanguages ? requested : undefined;
}
export async function highlightCode(text: string, language: string) {
  const instance = await getHighlighter();
  if (!instance.getLoadedLanguages().includes(language)) {
    const load = bundledLanguages[language] as
      (() => Promise<LanguageInput>) | undefined;
    if (!load) return [];
    await instance.loadLanguage(await load());
  }
  return instance.codeToTokens(text, {
    lang: language,
    theme: "github-light",
  }).tokens;
}
export function accessibleColor(color: unknown): string {
  if (typeof color !== "string" || !/^#[0-9a-f]{6}$/i.test(color))
    return "#202329";
  let rgb = [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16));
  const luminance = (channels: number[]) =>
    channels
      .map((c) => {
        const x = c / 255;
        return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
      })
      .reduce((s, x, i) => s + x * [0.2126, 0.7152, 0.0722][i], 0);
  const background = luminance([246, 247, 250]);
  while ((background + 0.05) / (luminance(rgb) + 0.05) < 4.6)
    rgb = rgb.map((c) => Math.floor(c * 0.94));
  return "#" + rgb.map((c) => c.toString(16).padStart(2, "0")).join("");
}
function ActionIcon({ name }: { name: "copy" | "run" }) {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path
        d={
          name === "copy"
            ? "M11 9h7a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-7a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2ZM6 15H5a1 1 0 0 1-1-1V6a2 2 0 0 1 2-2h8a1 1 0 0 1 1 1v1"
            : "m8 5 11 7-11 7V5Z"
        }
      />
    </svg>
  );
}
function shellLanguage(language?: string) {
  return (
    !!language && ["bash", "sh", "shell", "zsh", "console"].includes(language)
  );
}
export function Code({
  text,
  className,
  onExecute,
}: {
  text: string;
  className?: string;
  onExecute?: (command: string) => void;
}) {
  const [highlight, setHighlight] = useState<{
    text: string;
    language: string;
    lines: ThemedToken[][];
  }>();
  const [copied, setCopied] = useState(false);
  const language = className?.replace("language-", "").toLowerCase();
  useEffect(() => {
    if (
      !language ||
      text.length > MAX_HIGHLIGHT_CHARS ||
      (text.match(/\n/g)?.length ?? 0) >= MAX_HIGHLIGHT_LINES
    )
      return;
    return scheduleHighlight(text, language, (tokens) => {
      if (tokens) setHighlight({ text, language, lines: tokens });
    });
  }, [language, text]);
  const lines =
    highlight?.text === text && highlight.language === language
      ? highlight.lines
      : undefined;
  const content: ReactNode = lines
    ? lines.map((line, i) => (
        <span key={i}>
          {line.map((token, j) => (
            <span key={j} style={{ color: accessibleColor(token.color) }}>
              {token.content}
            </span>
          ))}
          {i < lines.length - 1 ? "\n" : ""}
        </span>
      ))
    : text;
  if (!className) return <code>{content}</code>;
  const command = text.trimEnd();
  return (
    <span className="code-block-content">
      <code className={className}>{content}</code>
      <span className="code-actions" role="group" aria-label="Code actions">
        <button
          type="button"
          aria-label={copied ? "Copied code" : "Copy code"}
          title={copied ? "Copied" : "Copy code"}
          onClick={() => {
            void navigator.clipboard.writeText(command).then(() => {
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1200);
            });
          }}
        >
          <ActionIcon name="copy" />
        </button>
        {shellLanguage(language) && onExecute && command && (
          <button
            type="button"
            aria-label="Run in terminal"
            title="Run in terminal"
            onClick={() => onExecute(command)}
          >
            <ActionIcon name="run" />
          </button>
        )}
      </span>
    </span>
  );
}
