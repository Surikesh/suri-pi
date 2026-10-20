import { useLayoutEffect, useEffect, useRef, useState } from "react";

export function useDetailsWidth({
  controlledWidth,
  onWidthChange,
  aside,
}: {
  controlledWidth?: number;
  onWidthChange?: (width: number, persist: boolean) => void;
  aside: React.RefObject<HTMLElement | null>;
}) {
  const [savedWidth, setSavedWidth] = useState(
    () => Number(localStorage.getItem("suri.details.width")) || 420,
  );
  const [viewportWidth, setViewportWidth] = useState(window.innerWidth);
  useEffect(() => {
    const update = () => setViewportWidth(window.innerWidth);
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);
  const [sidebarWidth, setSidebarWidth] = useState(0);
  useLayoutEffect(() => {
    const sidebar = aside.current?.parentElement?.querySelector(".sidebar");
    if (!sidebar) return;
    const measure = () =>
      setSidebarWidth(sidebar.getBoundingClientRect().width);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(sidebar, { box: "border-box" });
    return () => observer.disconnect();
  }, []);
  const minWidth = Math.min(300, viewportWidth);
  const maxWidth =
    viewportWidth > 1100
      ? Math.max(minWidth, viewportWidth - sidebarWidth - 328)
      : viewportWidth;
  const width = Math.max(
    minWidth,
    Math.min(maxWidth, controlledWidth ?? savedWidth),
  );
  const resizeStart = useRef<{ x: number; width: number } | undefined>(
    undefined,
  );
  const resize = (next: number, persist: boolean) => {
    const bounded = Math.round(Math.max(minWidth, Math.min(maxWidth, next)));
    setSavedWidth(bounded);
    if (persist) localStorage.setItem("suri.details.width", String(bounded));
    onWidthChange?.(bounded, persist);
  };
  return { minWidth, maxWidth, width, resize, resizeStart };
}
