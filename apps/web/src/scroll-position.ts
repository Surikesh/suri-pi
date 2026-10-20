export function createScrollPositionWriter(
  selected: () => string | null,
  storage: Pick<Storage, "setItem" | "removeItem">,
) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return {
    save(sessionId: string, top: number, bottom: boolean) {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = undefined;
        if (selected() !== sessionId) return;
        if (bottom) storage.removeItem(`suri.scroll.${sessionId}`);
        else storage.setItem(`suri.scroll.${sessionId}`, String(top));
      }, 120);
    },
    cancel() {
      if (timer) clearTimeout(timer);
      timer = undefined;
    },
  };
}
