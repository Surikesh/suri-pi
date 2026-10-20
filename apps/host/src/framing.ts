import { createHash, randomUUID } from "node:crypto";
import type { Data } from "../../../packages/protocol/src/index.js";
export function snapshotFrames(
  streamId: string,
  seq: number,
  hostEpoch: string,
  payload: Data,
): Data[] {
  const text = JSON.stringify(payload);
  if (Buffer.byteLength(text) > 32 * 1048576)
    throw Error("Snapshot exceeds assembly budget");
  if (Buffer.byteLength(text) < 512 * 1024)
    return [{ v: 1, type: "snapshot", streamId, seq, hostEpoch, payload }];
  const bytes = Buffer.from(text);
  const snapshotId = randomUUID();
  const parts = Math.ceil(bytes.length / (384 * 1024));
  const frames: Data[] = [
    {
      v: 1,
      type: "snapshot.begin",
      snapshotId,
      streamId,
      seq,
      hostEpoch,
      parts,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    },
  ];
  for (let i = 0; i < parts; i++)
    frames.push({
      v: 1,
      type: "snapshot.part",
      snapshotId,
      streamId,
      index: i,
      dataBase64: bytes
        .subarray(i * 384 * 1024, (i + 1) * 384 * 1024)
        .toString("base64"),
    });
  frames.push({ v: 1, type: "snapshot.end", snapshotId, streamId });
  return frames;
}
