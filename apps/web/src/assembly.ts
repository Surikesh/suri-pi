import type { Data } from "../../../packages/protocol/src/index.js";
export class SnapshotAssembler {
  private items = new Map<
    string,
    {
      head: Data;
      parts: string[];
      queued: Data[];
      bytes: number;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  constructor(
    private apply: (event: Data) => void,
    private reset: (stream: string) => void,
  ) {}
  receive(event: Data) {
    const stream = event.streamId;
    const item = this.items.get(stream);
    if (event.type === "snapshot.begin") {
      if (item) clearTimeout(item.timer);
      if (
        !Number.isInteger(event.parts) ||
        event.parts < 1 ||
        event.parts > 86
      ) {
        this.reset(stream);
        return;
      }
      const timer = setTimeout(() => {
        this.items.delete(stream);
        this.reset(stream);
      }, 10000);
      this.items.set(stream, {
        head: event,
        parts: [],
        queued: [],
        bytes: 0,
        timer,
      });
      return;
    }
    if (event.type === "snapshot.part") {
      if (
        !item ||
        event.snapshotId !== item.head.snapshotId ||
        event.index !== item.parts.length ||
        typeof event.dataBase64 !== "string" ||
        event.dataBase64.length > 512 * 1024
      ) {
        this.fail(stream);
        return;
      }
      item.parts.push(event.dataBase64);
      return;
    }
    if (event.type === "snapshot.end") {
      if (
        !item ||
        event.snapshotId !== item.head.snapshotId ||
        item.parts.length !== item.head.parts
      ) {
        this.fail(stream);
        return;
      }
      void this.finish(stream, item);
      return;
    }
    if (item) {
      item.bytes += JSON.stringify(event).length;
      if (item.bytes > 4 * 1048576) {
        this.fail(stream);
        return;
      }
      item.queued.push(event);
      return;
    }
    this.apply(event);
  }
  private fail(stream: string) {
    const item = this.items.get(stream);
    if (item) clearTimeout(item.timer);
    this.items.delete(stream);
    this.reset(stream);
  }
  private async finish(
    stream: string,
    item: {
      head: Data;
      parts: string[];
      queued: Data[];
      bytes: number;
      timer: ReturnType<typeof setTimeout>;
    },
  ) {
    try {
      const chunks = item.parts.map((s) =>
        Uint8Array.from(atob(s), (c) => c.charCodeAt(0)),
      );
      const length = chunks.reduce((sum, c) => sum + c.length, 0);
      if (length > 32 * 1048576) throw Error();
      const all = new Uint8Array(length);
      let offset = 0;
      for (const c of chunks) {
        all.set(c, offset);
        offset += c.length;
      }
      const hash = Array.from(
        new Uint8Array(await crypto.subtle.digest("SHA-256", all)),
      )
        .map((x) => x.toString(16).padStart(2, "0"))
        .join("");
      if (hash !== item.head.sha256) throw Error();
      const payload = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(all),
      );
      if (this.items.get(stream) !== item) return;
      clearTimeout(item.timer);
      this.items.delete(stream);
      this.apply({
        v: 1,
        type: "snapshot",
        streamId: stream,
        seq: item.head.seq,
        hostEpoch: item.head.hostEpoch,
        payload,
      });
      for (const e of item.queued) this.apply(e);
    } catch {
      this.fail(stream);
    }
  }
}
