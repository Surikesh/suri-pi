import { FileTypeIcon } from "../../file-preview.js";

export function ChangedFiles({
  paths,
  pin,
  open,
  menu,
}: {
  paths: string[];
  pin: (path: string) => void;
  open: (path: string) => void;
  menu: (path: string, x: number, y: number, trigger: HTMLElement) => void;
}) {
  return (
    <div className="message-changed-files" aria-label="Files changed">
      <span className="message-changed-label">Files changed</span>
      <div className="message-changed-links">
        {paths.map((path) => (
          <button
            key={path}
            className="message-file-link"
            title={`${path} · current workspace changes · click to pin; double-click to open`}
            aria-description="Review current workspace changes, not a saved response snapshot."
            onClick={() => pin(path)}
            onDoubleClick={() => open(path)}
            onContextMenu={(event) => {
              event.preventDefault();
              menu(path, event.clientX, event.clientY, event.currentTarget);
            }}
          >
            <FileTypeIcon path={path} />
            <span>{path}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
