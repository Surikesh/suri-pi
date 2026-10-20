import { StringDecoder } from "node:string_decoder";
import type { Data } from "../../protocol/src/index.js";

export class JsonlDecoder {
  private decoder = new StringDecoder("utf8");
  private buffer = "";
  private bytes = 0;
  private dropping = false;
  private resume?: NodeJS.Immediate;
  private ended = false;
  private waiters: Array<() => void> = [];
  constructor(
    private record: (r: Data) => void,
    private fail: (code: string) => void,
    private limit = 32 * 1024 * 1024,
    /**
     * Ordering barrier: records that follow a response are delivered only
     * after a macrotask boundary, so the response's promise continuations
     * (the command completion) run before any later event, however the pipe
     * coalesces them (Linux delivers them in one chunk). The barrier also
     * holds while draining at end of input; `drained()` reports completion.
     */
    private yieldAfterResponse = false,
  ) {}
  /** True when no records are waiting behind an ordering barrier. */
  get idle() {
    return !this.resume;
  }
  /** Resolves once every record fed so far has been delivered. */
  drained(): Promise<void> {
    return this.idle
      ? Promise.resolve()
      : new Promise((resolve) => this.waiters.push(resolve));
  }
  feed(chunk: Buffer) {
    this.bytes += chunk.length;
    this.buffer += this.decoder.write(chunk);
    if (!this.resume) this.drain();
  }
  end() {
    if (this.ended) return;
    this.ended = true;
    this.buffer += this.decoder.end();
    if (!this.resume) this.drain();
  }
  private drain() {
    this.flush();
    if (!this.resume) for (const resolve of this.waiters.splice(0)) resolve();
  }
  private flush() {
    const eof = this.ended;
    let pos: number;
    while ((pos = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, pos).replace(/\r$/, "");
      this.buffer = this.buffer.slice(pos + 1);
      if (this.dropping) this.dropping = false;
      else if (this.deliver(line)) return;
    }
    if (this.dropping) {
      this.buffer = "";
      if (eof) this.dropping = false;
      return;
    }
    this.bytes = Buffer.byteLength(this.buffer);
    if (this.bytes > this.limit) {
      this.buffer = "";
      this.dropping = !eof;
      this.fail("LIMIT_EXCEEDED");
    }
    if (eof && this.buffer) {
      const tail = this.buffer;
      this.buffer = "";
      this.deliver(tail);
    }
  }
  /**
   * The only path that hands a record to the consumer. A response arms the
   * barrier, even with nothing buffered and also for the unterminated tail at
   * end of input: later chunks, the end-of-input flush and drained() all wait
   * until the response's promise continuations have run. Returns true when the
   * barrier was armed and the caller must stop draining.
   */
  private deliver(line: string): boolean {
    if (!this.parse(line)) return false;
    this.resume = setImmediate(() => {
      this.resume = undefined;
      this.drain();
    });
    return true;
  }
  /** Returns true when the line was a response the caller should yield after. */
  private parse(line: string): boolean {
    if (!line) return false;
    if (Buffer.byteLength(line) > this.limit) {
      this.fail("LIMIT_EXCEEDED");
      return false;
    }
    try {
      const r = JSON.parse(line);
      if (!r || typeof r.type !== "string") throw Error();
      this.record(r);
      return this.yieldAfterResponse && r.type === "response";
    } catch {
      this.fail("MALFORMED_RPC");
      return false;
    }
  }
}
