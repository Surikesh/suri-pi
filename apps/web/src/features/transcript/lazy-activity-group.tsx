import React, { useState } from "react";
import { viewStorage as localStorage } from "../../view-storage.js";
import { Icon } from "../../components/ui.js";

export function LazyActivityGroup({
  className,
  "data-transcript-id": transcriptId,
  label,
  sessionId,
  render,
}: {
  className: string;
  "data-transcript-id": string;
  label: string;
  sessionId: string;
  render: () => React.ReactNode;
}) {
  const key = `suri.activity.${sessionId}.${transcriptId}`;
  const [open, setOpen] = useState(() => localStorage.getItem(key) === "true");
  return (
    <details
      className={className}
      data-transcript-id={transcriptId}
      open={open}
      onToggle={(event) => {
        const next = event.currentTarget.open;
        setOpen(next);
        localStorage.setItem(key, String(next));
      }}
    >
      <summary aria-label={`${label}, show activity`}>
        <span>{label}</span>
        <Icon name="chevronRight" />
      </summary>
      {open && <div className="activity-group-items">{render()}</div>}
    </details>
  );
}
