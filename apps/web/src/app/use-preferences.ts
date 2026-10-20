import { useEffect, useRef, useState } from "react";
import type { Data } from "../../../../packages/protocol/src/index.js";
import { command, report, select, type State } from "../store.js";

export function usePreferences({ state }: { state: State }) {
  const [prefs, setPrefs] = useState<Data>({
    revision: 0,
    values: {
      sidebarWidth: 232,
      detailsWidth: 360,
      fontScale: 1,
      navigationGroup: "workspace",
      navigationOrder: "updated",
      navigationUnreadOnly: false,
      navigationRecentOnly: false,
      projectCollapsed: {},
      projectSessionsExpanded: {},
    },
  });
  const prefsRef = useRef(prefs);
  const preferenceChain = useRef<Promise<unknown>>(Promise.resolve());
  useEffect(() => {
    if (state.ready)
      void command("preferences.get")
        .then((p) => {
          prefsRef.current = p;
          setPrefs(p);
          if (!state.selected && p.values?.selectedSession)
            select(p.values.selectedSession);
        })
        .catch(report);
  }, [state.ready]);
  useEffect(() => {
    prefsRef.current = prefs;
  }, [prefs]);
  useEffect(() => {
    document.documentElement.style.setProperty(
      "--sidebar-width",
      `${prefs.values.sidebarWidth ?? 232}px`,
    );
    document.documentElement.style.setProperty(
      "--details-width",
      `${prefs.values.detailsWidth ?? 360}px`,
    );
    document.documentElement.style.fontSize = `${14 * (prefs.values.fontScale ?? 1)}px`;
  }, [prefs]);
  const patchPreferences = (patch: Data) => {
    // A failed earlier patch was already reported; it must not block the next patch in the chain.
    preferenceChain.current = preferenceChain.current
      .catch(() => undefined)
      .then(async () => {
        const current = prefsRef.current;
        const next = await command(
          "preferences.patch",
          { patch },
          undefined,
          current.revision,
        );
        prefsRef.current = next;
        setPrefs(next);
      })
      .catch(report);
    return preferenceChain.current;
  };
  const setSidebarWidth = (width: number, persist = false) => {
    const bounded = Math.min(520, Math.max(200, Math.round(width)));
    setPrefs((current) => {
      const next = {
        ...current,
        values: { ...current.values, sidebarWidth: bounded },
      };
      prefsRef.current = next;
      return next;
    });
    if (persist) void patchPreferences({ sidebarWidth: bounded });
  };
  return { prefs, setPrefs, prefsRef, patchPreferences, setSidebarWidth };
}

export type PreferencesState = ReturnType<typeof usePreferences>;
