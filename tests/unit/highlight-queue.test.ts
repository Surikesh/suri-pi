import { afterEach, expect, it, vi } from "vitest";
import { createHighlightQueue } from "../../apps/web/src/highlight-queue.js";

afterEach(() => vi.useRealTimers());
function fixture() {
  vi.useFakeTimers();
  const workers: Array<{
    onmessage?: (event: any) => void;
    onerror?: () => void;
    postMessage: ReturnType<typeof vi.fn>;
    terminate: ReturnType<typeof vi.fn>;
  }> = [];
  const schedule = createHighlightQueue(() => {
    const worker = { postMessage: vi.fn(), terminate: vi.fn() };
    workers.push(worker);
    return worker as unknown as Worker;
  });
  return { workers, schedule };
}
it("recovers queued highlighting after a running worker crashes; ignores late results", () => {
  const { workers, schedule } = fixture();
  const failed = vi.fn(),
    next = vi.fn();
  schedule("first", "ts", failed);
  schedule("second", "ts", next);
  vi.runOnlyPendingTimers();
  const stale = workers[0].onmessage!;
  workers[0].onerror!();
  vi.runOnlyPendingTimers();
  expect(workers[0].terminate).toHaveBeenCalledOnce();
  expect(failed).toHaveBeenCalledWith();
  expect(workers[1].postMessage).toHaveBeenCalledWith(
    expect.objectContaining({ text: "second" }),
  );
  stale({ data: { id: 1, lines: [["stale"]] } });
  expect(next).not.toHaveBeenCalled();
  workers[1].onmessage!({ data: { id: 2, lines: [["ok"]] } });
  expect(next).toHaveBeenCalledWith([["ok"]]);
});
it("cancels a running job, terminates its worker and starts the queued job", () => {
  const { workers, schedule } = fixture();
  const cancelled = vi.fn(),
    next = vi.fn();
  const cancel = schedule("first", "ts", cancelled);
  schedule("second", "ts", next);
  vi.runOnlyPendingTimers();
  cancel();
  vi.runOnlyPendingTimers();
  expect(workers[0].terminate).toHaveBeenCalledOnce();
  expect(workers[1].postMessage).toHaveBeenCalledWith(
    expect.objectContaining({ text: "second" }),
  );
  workers[1].onmessage!({ data: { id: 2, lines: [["ok"]] } });
  expect(cancelled).not.toHaveBeenCalled();
  expect(next).toHaveBeenCalledOnce();
});
