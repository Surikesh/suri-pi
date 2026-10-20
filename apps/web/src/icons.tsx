export const folderPath =
  "M3 10V8a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-8Zm0 1h18";

export function FolderIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={folderPath} />
    </svg>
  );
}

export type ActivityIconName =
  "read" | "search" | "think" | "terminal" | "tool" | "write";

function ActivityGlyph({ name }: { name: ActivityIconName }) {
  switch (name) {
    case "read":
      return (
        <>
          <path d="M7 3.5h7l4 4v12a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1v-15a1 1 0 0 1 1-1Z" />
          <path d="M14 3.5V8h4M9 12h6M9 16h5" />
        </>
      );
    case "think":
      return (
        <>
          <ellipse
            cx="12"
            cy="12"
            rx="8.5"
            ry="4.1"
            transform="rotate(45 12 12)"
          />
          <ellipse
            cx="12"
            cy="12"
            rx="8.5"
            ry="4.1"
            transform="rotate(-45 12 12)"
          />
          <circle cx="12" cy="12" r="1.65" fill="currentColor" stroke="none" />
        </>
      );
    case "terminal":
      return (
        <>
          <rect x="3.5" y="4" width="17" height="16" rx="2" />
          <path d="M3.5 9h17M7 12.5l2.25 2L7 16.5M12.5 16.5H16" />
          <circle cx="7" cy="6.5" r="0.75" fill="currentColor" stroke="none" />
          <circle cx="10" cy="6.5" r="0.75" fill="currentColor" stroke="none" />
          <circle cx="13" cy="6.5" r="0.75" fill="currentColor" stroke="none" />
        </>
      );
    case "tool":
      return (
        <>
          <path d="m21 3.2-4.2 4.2-3.2-.8-.8-3.2L17 1.2a6 6 0 0 0-7.1 7.6l-6.6 6.6A3.3 3.3 0 1 0 8 20.1l6.6-6.6A6 6 0 0 0 21 3.2Z" />
          <circle
            cx="5.65"
            cy="17.75"
            r="0.8"
            fill="currentColor"
            stroke="none"
          />
        </>
      );
    case "write":
      return (
        <>
          <path d="m4 20 .9-4.2L15.8 4.9a2.1 2.1 0 0 1 3 0l.3.3a2.1 2.1 0 0 1 0 3L8.2 19.1 4 20Z" />
          <path d="m14.3 6.4 3.3 3.3M4.9 15.8l3.3 3.3" />
        </>
      );
    case "search":
      return (
        <>
          <circle cx="10.5" cy="10.5" r="6.5" />
          <path d="m15.3 15.3 4.7 4.7" />
        </>
      );
  }
}

/** Suri-owned SVG glyphs drawn directly on a 24px grid. */
export function ActivityIcon({ name }: { name: ActivityIconName }) {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      shapeRendering="geometricPrecision"
      aria-hidden="true"
    >
      <ActivityGlyph name={name} />
    </svg>
  );
}
