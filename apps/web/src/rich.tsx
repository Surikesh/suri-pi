import Markdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import { Code } from "./code.js";
import { classifyFileType, DshFileIcon } from "./dsh-file-icons.js";
function homeDirectoryForWorkspace(workspaceRoot: string) {
  const match = workspaceRoot.match(/^(\/Users\/[^/]+|\/home\/[^/]+)(?:\/|$)/);
  return match?.[1];
}

export function localPath(href: string | undefined, workspaceRoot?: string) {
  if (!href || !workspaceRoot) return undefined;
  let path: string;
  let trustedBridge = false;
  try {
    if (href.startsWith("https://herdr-local-file.invalid/")) {
      const url = new URL(href);
      if (url.pathname !== "/open") return undefined;
      const bridgedPath = url.searchParams.get("path");
      if (!bridgedPath?.startsWith("/")) return undefined;
      path = bridgedPath;
      trustedBridge = true;
    } else if (href.startsWith("file://"))
      path = decodeURIComponent(new URL(href).pathname);
    else if (href.startsWith("/")) path = decodeURIComponent(href);
    else if (href.startsWith("~/")) {
      const home = homeDirectoryForWorkspace(workspaceRoot);
      if (!home) return undefined;
      path = `${home}/${decodeURIComponent(href.slice(2))}`;
      trustedBridge = true;
    } else {
      if (
        (/^[a-z][a-z0-9+.-]*:/i.test(href) &&
          !/^[^:]+:\d+(?::\d+)?$/.test(href)) ||
        href.startsWith("#")
      )
        return undefined;
      const segments = href.split("/");
      if (segments.some((segment) => segment === "..")) return undefined;
      path = `${workspaceRoot}/${href.replace(/^\.\//, "")}`;
    }
  } catch {
    return undefined;
  }
  return trustedBridge ||
    path === workspaceRoot ||
    path.startsWith(`${workspaceRoot}/`)
    ? path
    : undefined;
}

function fileTarget(path: string) {
  const match = path.match(/(?::(\d+)(?::\d+)?|#L(\d+))$/);
  return {
    path: match ? path.slice(0, match.index) : path,
    line: match ? Number(match[1] ?? match[2]) : undefined,
  };
}

function localMentionPath(value: string, workspaceRoot?: string) {
  const mention = value.trim();
  if (
    mention.includes("\n") ||
    !/(?:^|\/)(?:\.[\w-]+|[^/\s]+\.[a-z0-9]{1,12})(?::\d+(?::\d+)?)?(?:#L\d+)?$/i.test(
      mention,
    )
  )
    return undefined;
  return localPath(mention, workspaceRoot);
}

export function localFileLabel(path: string, workspaceRoot?: string) {
  const target = fileTarget(path);
  const relative = workspaceRoot?.endsWith("/")
    ? workspaceRoot.slice(0, -1)
    : workspaceRoot;
  const label =
    relative && target.path.startsWith(`${relative}/`)
      ? target.path.slice(relative.length + 1)
      : target.path.split("/").at(-1) || target.path;
  return `${label}${target.line ? `:${target.line}` : ""}`;
}

function openLocalFile(path: string) {
  window.dispatchEvent(
    new CustomEvent("suri-open-file", { detail: fileTarget(path) }),
  );
}

function openLocalFileMenu(
  path: string,
  event: {
    preventDefault: () => void;
    currentTarget: HTMLButtonElement;
    clientX?: number;
    clientY?: number;
  },
) {
  event.preventDefault();
  const bounds = event.currentTarget.getBoundingClientRect();
  window.dispatchEvent(
    new CustomEvent("suri-file-menu", {
      detail: {
        ...fileTarget(path),
        x: event.clientX || bounds.left,
        y: event.clientY || bounds.bottom,
        trigger: event.currentTarget,
      },
    }),
  );
}

function LocalFileReference({
  path,
  workspaceRoot,
  inlineCode = false,
}: {
  path: string;
  workspaceRoot?: string;
  inlineCode?: boolean;
}) {
  const target = fileTarget(path);
  const label = localFileLabel(path, workspaceRoot);
  return (
    <span className="local-file-link">
      <button
        className={inlineCode ? "inline-file-link" : undefined}
        aria-label={`Open ${label}`}
        aria-haspopup="menu"
        title={`${target.path} · click to preview · right-click for file actions`}
        onClick={() => openLocalFile(path)}
        onContextMenu={(event) => openLocalFileMenu(path, event)}
        onKeyDown={(event) => {
          if (
            event.key === "ContextMenu" ||
            (event.shiftKey && event.key === "F10")
          )
            openLocalFileMenu(path, event);
        }}
      >
        <span className="local-file-icon" aria-hidden="true">
          <DshFileIcon kind={classifyFileType(target.path)} size={15} />
        </span>
        <span className="local-file-name">
          {inlineCode ? <Code text={label} /> : label}
        </span>
      </button>
    </span>
  );
}

export default function Rich({
  text,
  workspaceRoot,
  onExecute,
}: {
  text: string;
  workspaceRoot?: string;
  onExecute?: (command: string) => void;
}) {
  return (
    <Markdown
      remarkPlugins={[remarkGfm]}
      urlTransform={(url) =>
        localPath(url, workspaceRoot) ? url : defaultUrlTransform(url)
      }
      components={{
        code: ({ className, children, node }) => {
          const value = String(children ?? "");
          const path =
            !className &&
            node?.position?.start.line === node?.position?.end.line
              ? localMentionPath(value, workspaceRoot)
              : undefined;
          return path ? (
            <LocalFileReference
              path={path}
              workspaceRoot={workspaceRoot}
              inlineCode
            />
          ) : (
            <Code className={className} text={value} onExecute={onExecute} />
          );
        },
        a: ({ href, children }) => {
          const path = localPath(href, workspaceRoot);
          if (!path)
            return (
              <a href={href} target="_blank" rel="noreferrer">
                {children}
              </a>
            );
          return (
            <LocalFileReference path={path} workspaceRoot={workspaceRoot} />
          );
        },
        img: () => <span className="muted">[Remote image withheld]</span>,
      }}
    >
      {text}
    </Markdown>
  );
}
