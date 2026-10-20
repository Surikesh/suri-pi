import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  Translator,
  JsonlDecoder,
} from "../../packages/pi-adapter/src/index.js";
import {
  initialProjection,
  reduce,
} from "../../packages/protocol/src/index.js";
for (const version of (
  process.env.SURI_FIXTURE_VERSIONS ?? "0.84.4,0.85.1"
).split(","))
  describe(`Pi ${version} independent fixture replay`, () => {
    const root = join("tests/fixtures/pi", version);
    for (const file of readdirSync(root).filter(
      (f) =>
        f.endsWith(".jsonl") &&
        !["client", "header"].includes(
          JSON.parse(
            readFileSync(
              join(root, f.replace(".jsonl", ".expected.json")),
              "utf8",
            ),
          ).driver,
        ),
    ))
      it(file, () => {
        const metadata = JSON.parse(
          readFileSync(
            join(root, file.replace(".jsonl", ".expected.json")),
            "utf8",
          ),
        );
        let state = initialProjection(),
          seq = 0;
        const emitted: any[] = [];
        const translator = new Translator((type, payload) => {
          emitted.push({ type, payload });
          state = reduce(state, { type, payload, seq: ++seq });
        });
        const errors: string[] = [];
        const decoder = new JsonlDecoder(
          (r) => translator.record(r),
          (e) => errors.push(e),
          metadata.expected.maxRecord,
        );
        const bytes = readFileSync(join(root, file));
        for (let i = 0; i < bytes.length; i += 7)
          decoder.feed(bytes.subarray(i, i + 7));
        decoder.end();
        expect(errors).toEqual(metadata.expected.errors ?? []);
        expect(JSON.stringify(emitted)).not.toContain("synthetic-secret");
        const e = metadata.expected;
        if (e.unicode)
          expect(JSON.stringify(state.messages)).toContain("Привет🙂");
        if ("outcome" in e) expect(state.outcome ?? null).toBe(e.outcome);
        if (e.phase) expect(state.phase).toBe(e.phase);
        if (e.toolPhase)
          expect(Object.values(state.tools).at(-1)?.phase).toBe(e.toolPhase);
        if ("queueLength" in e) expect(state.queue.length).toBe(e.queueLength);
        if ("noticeCount" in e)
          expect(state.notices).toHaveLength(e.noticeCount);
        if (e.extensionMethod)
          expect(
            emitted.find((x) => x.type === "extension.request").payload.method,
          ).toBe(e.extensionMethod);
      });
  });
