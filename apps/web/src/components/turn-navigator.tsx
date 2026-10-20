import { useEffect, useRef, useState, type RefObject } from "react";

type TurnMark = { id: string; preview: string };

type Props = {
  marks: TurnMark[];
  scroller: RefObject<HTMLDivElement | null>;
  onNavigate: (id: string) => void;
};

/** A local outline of user messages currently present in the transcript. */
export function TurnNavigator({ marks, scroller, onNavigate }: Props) {
  const rail = useRef<HTMLElement>(null);
  const [active, setActive] = useState(0);
  const [preview, setPreview] = useState<{
    index: number;
    top: number;
    right: number;
  } | null>(null);
  const showPreview = (index: number, button: HTMLButtonElement) => {
    const rect = button.getBoundingClientRect();
    setPreview({
      index,
      top: Math.max(8, Math.min(innerHeight - 86, rect.top - 24)),
      right: innerWidth - rect.left + 10,
    });
  };

  useEffect(() => {
    const viewport = scroller.current;
    if (!viewport || marks.length < 2) return;
    let frame = 0;
    const measure = () => {
      frame = 0;
      const line =
        viewport.getBoundingClientRect().top +
        Math.min(96, viewport.clientHeight * 0.2);
      let current = 0;
      if (
        viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight <
        64
      ) {
        current = marks.length - 1;
      } else {
        for (let index = 0; index < marks.length; index++) {
          const row = viewport.querySelector<HTMLElement>(
            `[data-transcript-id="${CSS.escape(`message:${marks[index].id}`)}"]`,
          );
          if (row && row.getBoundingClientRect().top > line) break;
          if (row) current = index;
        }
      }
      setActive((previous) => (previous === current ? previous : current));
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };
    schedule();
    viewport.addEventListener("scroll", schedule, { passive: true });
    const observer = new ResizeObserver(schedule);
    observer.observe(viewport);
    const content = viewport.querySelector(":scope > .rail");
    if (content) observer.observe(content);
    return () => {
      viewport.removeEventListener("scroll", schedule);
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [marks, scroller]);

  useEffect(() => {
    const viewport = rail.current;
    const mark = viewport?.querySelector<HTMLElement>(
      `[data-turn-index="${active}"]`,
    );
    if (!viewport || !mark) return;
    const bounds = mark.getBoundingClientRect();
    const visible = viewport.getBoundingClientRect();
    if (bounds.top < visible.top)
      viewport.scrollTop -= visible.top - bounds.top;
    else if (bounds.bottom > visible.bottom)
      viewport.scrollTop += bounds.bottom - visible.bottom;
  }, [active, marks]);

  if (marks.length < 2) return null;
  return (
    <>
      <nav ref={rail} className="turn-navigator" aria-label="Your messages">
        {marks.map((mark, index) => (
          <button
            key={mark.id}
            type="button"
            data-turn-index={index}
            className={index === active ? "turn-mark active" : "turn-mark"}
            aria-label={`Jump to your message ${index + 1}: ${mark.preview}`}
            aria-current={index === active ? "location" : undefined}
            aria-describedby={
              preview?.index === index ? "turn-mark-preview" : undefined
            }
            onClick={() => onNavigate(mark.id)}
            onMouseEnter={(event) => showPreview(index, event.currentTarget)}
            onMouseLeave={() => setPreview(null)}
            onFocus={(event) => showPreview(index, event.currentTarget)}
            onBlur={() => setPreview(null)}
          >
            <span className="turn-mark-stroke" aria-hidden="true" />
          </button>
        ))}
      </nav>
      {preview && (
        <span
          id="turn-mark-preview"
          role="tooltip"
          className="turn-mark-preview"
          style={{ top: preview.top, right: preview.right }}
        >
          {marks[preview.index]?.preview}
        </span>
      )}
    </>
  );
}
