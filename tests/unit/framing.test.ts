import { it, expect } from "vitest";
import { snapshotFrames } from "../../apps/host/src/framing.js";
import { SnapshotAssembler } from "../../apps/web/src/assembly.js";
it("atomically verifies multipart snapshots before flushing newer events", async () => {
  const payload = { text: "🙂".repeat(200000) };
  const frames = snapshotFrames("session:test", 12, "epoch", payload);
  expect(frames.length).toBeGreaterThan(2);
  const emitted: any[] = [],
    resets: string[] = [];
  const assembler = new SnapshotAssembler(
    (e) => emitted.push(e),
    (s) => resets.push(s),
  );
  for (const f of frames) assembler.receive(f);
  assembler.receive({
    streamId: "session:test",
    seq: 13,
    type: "run.state",
    payload: { phase: "idle" },
  });
  expect(emitted).toHaveLength(0);
  await new Promise((r) => setTimeout(r, 20));
  expect(resets).toEqual([]);
  expect(emitted[0].payload.text).toBe(payload.text);
  expect(emitted[1].seq).toBe(13);
});
it("rejects corrupt snapshot content and requests a reset", async () => {
  const frames = snapshotFrames("session:test", 2, "epoch", {
    text: "x".repeat(700000),
  });
  frames[1].dataBase64 = Buffer.from("corrupt").toString("base64");
  const emitted: any[] = [],
    resets: string[] = [];
  const assembler = new SnapshotAssembler(
    (e) => emitted.push(e),
    (s) => resets.push(s),
  );
  for (const f of frames) assembler.receive(f);
  await new Promise((r) => setTimeout(r, 20));
  expect(emitted).toEqual([]);
  expect(resets).toEqual(["session:test"]);
});
