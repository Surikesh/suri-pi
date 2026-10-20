import { useEffect, useMemo, useRef, useState } from "react";
import type { Data } from "../../../../../packages/protocol/src/index.js";
import { modelKey, searchModels } from "../../model-search.js";

export type ModelSearchProps = {
  sessionId: string;
  display: string;
  selected?: string;
  disabled?: boolean;
  starting?: boolean;
  models: Data[];
  cached: boolean;
  prefetchError?: string;
  scope: string[] | null;
  openSignal: number;
  load: (refresh?: boolean) => Promise<void>;
  choose: (model: Data) => Promise<void>;
};

export function useModelSearch({
  selected,
  starting,
  models,
  cached,
  prefetchError,
  scope,
  openSignal,
  load,
  choose,
}: Pick<
  ModelSearchProps,
  | "selected"
  | "starting"
  | "models"
  | "cached"
  | "prefetchError"
  | "scope"
  | "openSignal"
  | "load"
  | "choose"
>) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [browse, setBrowse] = useState(false);
  const [phase, setPhase] = useState<
    "idle" | "loading" | "ready" | "error" | "selection-error" | "selecting"
  >("idle");
  const [error, setError] = useState("");
  const [active, setActive] = useState(0);
  const [windowStart, setWindowStart] = useState(0);
  const [menuPosition, setMenuPosition] = useState({ left: 12, bottom: 60 });
  const trigger = useRef<HTMLButtonElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const token = useRef(0);
  const lastOpenSignal = useRef(openSignal);
  const busy = useRef(false);
  const loading = useRef<Promise<void> | null>(null);
  const intent = query.trim().length > 0 || browse;
  const options = useMemo(
    () =>
      intent && phase === "ready"
        ? searchModels(
            models.filter(
              (model) =>
                scope === null ||
                scope.includes(modelKey(model)) ||
                modelKey(model) === selected,
            ),
            query,
            selected,
          )
        : [],
    [models, scope, query, selected, intent, phase],
  );
  const duplicateNames = useMemo(() => {
    const counts = new Map<string, number>();
    for (const model of models) {
      const name = `${model.provider}\0${model.name || model.id}`;
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    return counts;
  }, [models]);
  // Keep a bounded number of options mounted while scrolling large catalogs.
  const virtual = options.length > 80;
  const start = virtual ? Math.min(windowStart, options.length - 40) : 0;
  const visible = virtual ? options.slice(start, start + 40) : options;
  const rowEstimate = 36;
  const close = (restoreFocus = true) => {
    token.current++;
    setOpen(false);
    if (restoreFocus) requestAnimationFrame(() => trigger.current?.focus());
  };
  const discover = async (refresh = false) => {
    const current = ++token.current;
    setError("");
    setPhase("loading");
    try {
      if (!loading.current) {
        const request = load(refresh);
        loading.current = request;
        // The awaiting caller below reports load failure; this branch only clears the in-flight marker without an unhandled rejection.
        void request
          .finally(() => {
            if (loading.current === request) loading.current = null;
          })
          .catch(() => {});
      }
      await loading.current;
      if (token.current === current) setPhase("ready");
    } catch (cause) {
      if (token.current === current) {
        setError(
          (cause as Error).message ||
            "Model discovery failed. Retry to try again.",
        );
        setPhase("error");
      }
    }
  };
  const positionMenu = () => {
    const bounds = trigger.current?.getBoundingClientRect();
    if (!bounds) return;
    const width = Math.min(420, window.innerWidth - 24);
    setMenuPosition({
      left: Math.max(
        12,
        Math.min(bounds.right - width, window.innerWidth - width - 12),
      ),
      bottom: window.innerHeight - bounds.top + 6,
    });
  };
  const show = () => {
    if (open) return;
    positionMenu();
    setOpen(true);
    setQuery("");
    setBrowse(false);
    setPhase(cached ? "ready" : prefetchError ? "error" : "idle");
    setError(prefetchError ?? "");
    setActive(0);
    setWindowStart(0);
    requestAnimationFrame(() => input.current?.focus());
  };
  useEffect(() => {
    if (openSignal === lastOpenSignal.current) return;
    lastOpenSignal.current = openSignal;
    show();
  }, [openSignal]);
  useEffect(
    () => () => {
      token.current++;
      if (document.activeElement === input.current)
        requestAnimationFrame(() => {
          (
            document.querySelector(
              '[aria-label="Message Pi"]',
            ) as HTMLElement | null
          )?.focus();
        });
    },
    [],
  );
  useEffect(() => {
    if (!open) return;
    window.addEventListener("resize", positionMenu);
    window.addEventListener("scroll", positionMenu, true);
    return () => {
      window.removeEventListener("resize", positionMenu);
      window.removeEventListener("scroll", positionMenu, true);
    };
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const escape = (event: KeyboardEvent) => {
      if (
        event.key === "Tab" &&
        menu.current?.contains(document.activeElement)
      ) {
        // The portal sits at the end of body, not beside its trigger. Let Tab
        // traverse the menu, then bridge only its boundaries to the page order.
        const items = Array.from(
          menu.current.querySelectorAll<HTMLElement>(
            "button:not(:disabled), input:not(:disabled), a[href]",
          ),
        ).filter((element) => element.getClientRects().length > 0);
        const index = items.indexOf(document.activeElement as HTMLElement);
        const nextItem = items[index + (event.shiftKey ? -1 : 1)];
        event.preventDefault();
        if (nextItem) {
          nextItem.focus();
          return;
        }
        const controls = Array.from(
          document.querySelectorAll<HTMLElement>(
            "button:not(:disabled), input:not(:disabled), textarea:not(:disabled), a[href]",
          ),
        ).filter(
          (element) =>
            !menu.current?.contains(element) &&
            element.getClientRects().length > 0,
        );
        const triggerIndex = controls.indexOf(trigger.current!);
        const next = controls[triggerIndex + (event.shiftKey ? -1 : 1)];
        close(false);
        (next ?? trigger.current)?.focus();
        return;
      }
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      close();
    };
    const outside = (event: PointerEvent) => {
      if (
        !trigger.current?.contains(event.target as Node) &&
        !menu.current?.contains(event.target as Node)
      )
        close();
    };
    window.addEventListener("keydown", escape, true);
    document.addEventListener("pointerdown", outside);
    return () => {
      window.removeEventListener("keydown", escape, true);
      document.removeEventListener("pointerdown", outside);
    };
  }, [open]);
  useEffect(() => {
    setActive(0);
    setWindowStart(0);
    if (list.current) list.current.scrollTop = 0;
  }, [query]);
  useEffect(() => {
    if (prefetchError && phase === "idle") {
      setError(prefetchError);
      setPhase("error");
    }
  }, [prefetchError, phase]);
  useEffect(() => {
    if (open && intent && phase === "idle" && !prefetchError) void discover();
  }, [open, intent, phase]);
  const selectModel = async (model: Data) => {
    if (busy.current || starting) return;
    busy.current = true;
    const current = token.current;
    setPhase("selecting");
    try {
      await choose(model);
      if (token.current === current) close();
    } catch (cause) {
      if (token.current === current) {
        setError((cause as Error).message || "Model selection failed.");
        setPhase("selection-error");
      }
    } finally {
      busy.current = false;
    }
  };
  return {
    open,
    setQuery,
    setBrowse,
    query,
    phase,
    error,
    active,
    setActive,
    setWindowStart,
    menuPosition,
    trigger,
    input,
    menu,
    list,
    intent,
    options,
    duplicateNames,
    virtual,
    start,
    visible,
    rowEstimate,
    close,
    discover,
    show,
    selectModel,
  };
}
