import type { ThemedToken } from "shiki/core";

type HighlightJob = {
  id: number;
  text: string;
  language: string;
  done: (lines?: ThemedToken[][]) => void;
};

/** One worker at a time; a failed or cancelled job cannot block subsequent jobs. */
export function createHighlightQueue(createWorker: () => Worker) {
  let worker: Worker | undefined;
  let running: HighlightJob | undefined;
  let nextId = 0;
  const pending: HighlightJob[] = [];
  const pump = () => {
    if (running || !pending.length) return;
    try {
      if (!worker) {
        const current = createWorker();
        worker = current;
        current.onmessage = (
          event: MessageEvent<{ id: number; lines?: ThemedToken[][] }>,
        ) => {
          if (worker !== current || running?.id !== event.data.id) return;
          const job = running;
          running = undefined;
          job.done(event.data.lines);
          setTimeout(pump, 0);
        };
        current.onerror = () => {
          if (worker !== current) return;
          current.terminate();
          worker = undefined;
          const job = running;
          running = undefined;
          job?.done();
          setTimeout(pump, 0);
        };
      }
      running = pending.shift();
      worker.postMessage({
        id: running!.id,
        text: running!.text,
        language: running!.language,
      });
    } catch {
      worker?.terminate();
      worker = undefined;
      running?.done();
      running = undefined;
      // A worker that cannot be constructed must not trigger an unbounded retry loop.
      if (pending.length) setTimeout(pump, 0);
    }
  };
  return (text: string, language: string, done: HighlightJob["done"]) => {
    const job = { id: ++nextId, text, language, done };
    pending.push(job);
    setTimeout(pump, 0);
    return () => {
      const index = pending.indexOf(job);
      if (index >= 0) pending.splice(index, 1);
      if (running === job) {
        worker?.terminate();
        worker = undefined;
        running = undefined;
        setTimeout(pump, 0);
      }
      job.done = () => {};
    };
  };
}
