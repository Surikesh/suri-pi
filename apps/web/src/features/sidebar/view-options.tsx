import type { SidebarProps } from "./types.js";

export function renderViewOptions(props: SidebarProps) {
  const { setViewOptions, setCatalogDialog, prefs, patchPreferences } = props;
  return (
    <div
      className="view-options"
      role="menu"
      aria-label="Session view options"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          setViewOptions(false);
        }
      }}
    >
      <button
        role="menuitem"
        onClick={() => {
          setCatalogDialog(null);
          setViewOptions(false);
        }}
      >
        Sidebar sections…
      </button>
      <div className="menu-separator" />
      <strong>
        View <kbd>⌃⌥L</kbd>
      </strong>
      <button
        role="menuitemradio"
        aria-checked={prefs.values.navigationGroup !== "list"}
        onClick={() => void patchPreferences({ navigationGroup: "workspace" })}
      >
        By project
      </button>
      <button
        role="menuitemradio"
        aria-checked={prefs.values.navigationGroup === "list"}
        onClick={() => void patchPreferences({ navigationGroup: "list" })}
      >
        By list
      </button>
      <strong>Order by</strong>
      <button
        role="menuitemradio"
        aria-checked={prefs.values.navigationOrder !== "updated"}
        onClick={() => void patchPreferences({ navigationOrder: "manual" })}
      >
        Manual
      </button>
      <button
        role="menuitemradio"
        aria-checked={prefs.values.navigationOrder === "updated"}
        onClick={() => void patchPreferences({ navigationOrder: "updated" })}
      >
        Last updated
      </button>
      <strong>Filter</strong>
      <button
        className="filter-option"
        role="menuitemcheckbox"
        aria-checked={!!prefs.values.navigationUnreadOnly}
        onClick={() =>
          void patchPreferences({
            navigationUnreadOnly: !prefs.values.navigationUnreadOnly,
          })
        }
      >
        Unread
      </button>
      <button
        className="filter-option"
        role="menuitemcheckbox"
        aria-checked={!!prefs.values.navigationRecentOnly}
        onClick={() =>
          void patchPreferences({
            navigationRecentOnly: !prefs.values.navigationRecentOnly,
          })
        }
      >
        Active in the last 7 days
      </button>
    </div>
  );
}
