import React, { useEffect, useRef, useState } from "react";
import type { Data } from "../../../../packages/protocol/src/index.js";
import { folderPath } from "../icons.js";
import { viewStorage as localStorage } from "../view-storage.js";

type TerminalGlyph =
  "plus" | "split-right" | "split-down" | "close" | "restart";

function Icon(
  props:
    | { name: string; variant?: undefined }
    | { name: TerminalGlyph; variant: "terminal" },
) {
  const { name } = props;
  if (props.variant === "terminal")
    return (
      <svg aria-hidden="true" viewBox="0 0 16 16" width="14" height="14">
        {name === "restart" && (
          <path d="M12.4 5.2A5 5 0 1 0 13 9M12.4 2.8v2.4H10" />
        )}
        {name === "plus" && <path d="M8 3.25v9.5M3.25 8h9.5" />}
        {name === "split-right" && (
          <>
            <rect x="2.25" y="2.75" width="11.5" height="10.5" rx="1.5" />
            <path d="M8 3v10" />
          </>
        )}
        {name === "split-down" && (
          <>
            <rect x="2.25" y="2.75" width="11.5" height="10.5" rx="1.5" />
            <path d="M2.5 8h11" />
          </>
        )}
        {name === "close" && <path d="m4.5 4.5 7 7m0-7-7 7" />}
      </svg>
    );
  const paths: Record<string, string> = {
    plus: "M12 5v14M5 12h14",
    send: "M12 19V5M6.5 10.5 12 5l5.5 5.5",
    menu: "M4 6h16M4 12h16M4 18h16",
    settings:
      "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8 M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M19 5l-2 2M7 17l-2 2",
    folder: folderPath,
    newSession:
      "M7 4h7a2 2 0 0 1 2 2v2M7 4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h5M13 17l6-6a1.4 1.4 0 0 1 2 2l-6 6-3 1 1-3Z",
    chevronRight: "m9 5 7 7-7 7",
    chevronDown: "m5 9 7 7 7-7",
    collapseAll: "m7 9 5 5 5-5 M7 4l5 5 5-5",
    expandAll: "m7 15 5 5 5-5 M7 9l5-5 5 5",
    close: "m6 6 12 12M18 6 6 18",
    panel:
      "M5 4h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2ZM15 4v16",
    stop: "M8 6h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2Z",
    attach: "m8 12 6-6a3 3 0 0 1 4 4l-8 8a5 5 0 0 1-7-7l8-8",
    search: "M10 4a6 6 0 1 0 0 12 6 6 0 0 0 0-12m5 11 5 5",
    dots: "M6 12h.01M12 12h.01M18 12h.01",
    file: "M8 3.5h6l4 4V19a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 6 19V5a1.5 1.5 0 0 1 1.5-1.5Zm6 0V8h4",
    pin: "m9 3 6 6-2 2 3 5-1 1-5-3-5 5-1-1 5-5-3-5Z M9 15l-5 5",
    copy: "M11 9h7a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-7a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2ZM6 15H5a1 1 0 0 1-1-1V6a2 2 0 0 1 2-2h8a1 1 0 0 1 1 1v1",
    branch:
      "M6 3v12a4 4 0 0 0 4 4h8 M14 15l4 4-4 4 M6 7a2 2 0 1 0 0-4 2 2 0 0 0 0 4",
    archive:
      "M5 7h14a1 1 0 0 1 1 1v11a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a1 1 0 0 1 1-1ZM5 3h14a2 2 0 0 1 2 2v2H3V5a2 2 0 0 1 2-2ZM9 12h6",
    highlight: "m7 16 7-7 4 4-7 7H7v-4Z M13 5l2-2 4 4-2 2",
    finder:
      "M3 7V5h6l2 2h10v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z M8 12h.01M16 12h.01 M8 17c2 2 6 2 8 0",
    remove: "M5 12h14",
    sliders:
      "M4 6h10M18 6h2M4 12h3M11 12h9M4 18h8M16 18h4 M14 4v4M7 10v4M12 16v4",
  };
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={paths[name] ?? paths.folder} />
    </svg>
  );
}

function Disclosure({
  id,
  className,
  children,
  renderDetail,
}: {
  id: string;
  className?: string;
  children: React.ReactNode;
  renderDetail?: () => React.ReactNode;
}) {
  const key = `suri.disclosure.${id}`;
  const [open, setOpen] = useState(localStorage.getItem(key) === "true");
  return (
    <details
      className={className}
      data-disclosure-id={id}
      open={open}
      onToggle={(e) => {
        const next = e.currentTarget.open;
        setOpen(next);
        localStorage.setItem(key, String(next));
      }}
    >
      {children}
      {open && renderDetail?.()}
    </details>
  );
}

function Picker({
  label,
  display,
  disabled,
  items,
  itemKey,
  itemLabel,
  load,
  choose,
  openSignal,
  selectedKey,
}: {
  label: string;
  selectedKey?: string;
  display: string;
  disabled?: boolean;
  items: Data[];
  itemKey: (item: Data) => string;
  itemLabel: (item: Data) => string;
  load: () => Promise<void>;
  choose: (item: Data) => Promise<void>;
  openSignal?: number;
}) {
  const [open, setOpen] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [loading, setLoading] = useState(false);
  const loadOptions = async () => {
    setLoading(true);
    setLoadError("");
    try {
      await load();
    } catch (e) {
      setLoadError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };
  const [active, setActive] = useState(0);
  const trigger = useRef<HTMLButtonElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  useEffect(() => {
    if (openSignal) {
      setOpen(true);
      void loadOptions();
    }
  }, [openSignal]);
  useEffect(() => {
    if (!open) return;
    const selected = Math.max(
      0,
      items.findIndex((item) => itemKey(item) === (selectedKey ?? display)),
    );
    setActive(selected);
    requestAnimationFrame(() => optionRefs.current[selected]?.focus());
  }, [open, items, display, itemKey, selectedKey]);
  const close = () => {
    setOpen(false);
    requestAnimationFrame(() => trigger.current?.focus());
  };
  useEffect(() => {
    if (!open) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      close();
    };
    const outside = (event: PointerEvent) => {
      if (!trigger.current?.parentElement?.contains(event.target as Node))
        close();
    };
    window.addEventListener("keydown", escape, true);
    document.addEventListener("pointerdown", outside);
    return () => {
      window.removeEventListener("keydown", escape, true);
      document.removeEventListener("pointerdown", outside);
    };
  }, [open]);
  return (
    <div className="picker">
      <button
        ref={trigger}
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => {
          if (open) close();
          else {
            setOpen(true);
            void loadOptions();
          }
        }}
      >
        {display}
      </button>
      {open && (
        <div
          className="picker-menu"
          role="listbox"
          aria-label={label}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              close();
            } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault();
              const delta = e.key === "ArrowDown" ? 1 : -1;
              const next = (active + delta + items.length) % items.length;
              setActive(next);
              optionRefs.current[next]?.focus();
            }
          }}
        >
          {loadError ? (
            <p role="alert">{loadError}</p>
          ) : items.length === 0 ? (
            <span className="picker-empty">
              {loading ? "Loading…" : "No options available"}
            </span>
          ) : (
            items.map((item, index) => (
              <button
                ref={(node) => {
                  optionRefs.current[index] = node;
                }}
                role="option"
                aria-selected={itemKey(item) === (selectedKey ?? display)}
                key={itemKey(item)}
                onFocus={() => setActive(index)}
                onClick={() => void choose(item).then(close)}
              >
                {itemLabel(item)}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}

function ActionError({
  message,
  onDismiss,
}: {
  message?: string;
  onDismiss: () => void;
}) {
  return message ? (
    <div className="error-banner" role="alert">
      <span>{message}</span>
      <button type="button" aria-label="Dismiss error" onClick={onDismiss}>
        <Icon name="close" />
      </button>
    </div>
  ) : null;
}

export { ActionError, Disclosure, Icon, Picker };
