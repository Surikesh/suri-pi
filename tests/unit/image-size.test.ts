import { describe, expect, it } from "vitest";
import { imageSize } from "../../apps/host/src/image-size.js";

const png = (width: number, height: number) => {
  const b = Buffer.alloc(33);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(b);
  b.writeUInt32BE(13, 8);
  b.write("IHDR", 12, "latin1");
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return b;
};
// SOI, APP0 (length 4), SOF0 (length 11: height, width, one component).
const jpeg = (width: number, height: number) =>
  Buffer.from([
    0xff,
    0xd8,
    0xff,
    0xe0,
    0x00,
    0x04,
    0x00,
    0x00,
    0xff,
    0xc0,
    0x00,
    0x0b,
    0x08,
    height >> 8,
    height & 255,
    width >> 8,
    width & 255,
    0x01,
    0x01,
    0x11,
    0x00,
  ]);
const riff = (kind: string, length: number) => {
  const b = Buffer.alloc(length);
  b.write("RIFF", 0, "latin1");
  b.write("WEBP", 8, "latin1");
  b.write(kind, 12, "latin1");
  b.writeUInt32LE(length - 8, 4);
  b.writeUInt32LE(length - 20, 16);
  return b;
};
const vp8x = (width: number, height: number) => {
  const b = riff("VP8X", 30);
  b.writeUIntLE(width - 1, 24, 3);
  b.writeUIntLE(height - 1, 27, 3);
  return b;
};
const vp8l = (width: number, height: number) => {
  const b = riff("VP8L", 25);
  b[20] = 0x2f;
  b.writeUInt32LE(((height - 1) << 14) | (width - 1), 21);
  return b;
};
const vp8 = (width: number, height: number) => {
  const b = riff("VP8 ", 30);
  Buffer.from([0x9d, 0x01, 0x2a]).copy(b, 23);
  b.writeUInt16LE(width, 26);
  b.writeUInt16LE(height, 28);
  return b;
};

describe("imageSize", () => {
  it("reads valid PNG, JPEG and WebP (VP8X, VP8L, VP8) headers", () => {
    expect(imageSize(png(300, 200), "image/png")).toEqual({
      width: 300,
      height: 200,
    });
    expect(imageSize(jpeg(30, 20), "image/jpeg")).toEqual({
      width: 30,
      height: 20,
    });
    expect(imageSize(vp8x(64, 32), "image/webp")).toEqual({
      width: 64,
      height: 32,
    });
    expect(imageSize(vp8l(100, 50), "image/webp")).toEqual({
      width: 100,
      height: 50,
    });
    expect(imageSize(vp8(48, 24), "image/webp")).toEqual({
      width: 48,
      height: 24,
    });
  });

  it("rejects every truncation of a valid header", () => {
    for (const [bytes, mime] of [
      [png(300, 200), "image/png"],
      [jpeg(30, 20), "image/jpeg"],
      [vp8x(64, 32), "image/webp"],
      [vp8l(100, 50), "image/webp"],
      [vp8(48, 24), "image/webp"],
    ] as const)
      for (let n = 0; n < bytes.length; n++)
        expect(imageSize(bytes.subarray(0, n), mime), `${mime}:${n}`).toBe(
          undefined,
        );
  });

  it("rejects structurally inconsistent headers", () => {
    const badChunk = png(1, 1);
    badChunk.writeUInt32BE(12, 8);
    expect(imageSize(badChunk, "image/png")).toBeUndefined();
    expect(imageSize(png(0, 5), "image/png")).toBeUndefined();

    const shortSof = jpeg(30, 20);
    shortSof.writeUInt16BE(2, 10);
    expect(imageSize(shortSof, "image/jpeg")).toBeUndefined();
    const shortSegment = jpeg(30, 20);
    shortSegment.writeUInt16BE(1, 4);
    expect(imageSize(shortSegment, "image/jpeg")).toBeUndefined();

    const noStartCode = vp8(48, 24);
    noStartCode[23] = 0;
    expect(imageSize(noStartCode, "image/webp")).toBeUndefined();
    const noMagic = vp8l(10, 10);
    noMagic[20] = 0;
    expect(imageSize(noMagic, "image/webp")).toBeUndefined();
    expect(imageSize(png(1, 1), "image/gif")).toBeUndefined();
  });

  it("rejects WebP whose declared RIFF or chunk sizes disagree with the input", () => {
    for (const make of [vp8x, vp8l, vp8]) {
      const riffZero = make(8, 8);
      riffZero.writeUInt32LE(0, 4);
      const riffPastInput = make(8, 8);
      riffPastInput.writeUInt32LE(riffPastInput.length - 7, 4);
      const chunkPastRiff = make(8, 8);
      chunkPastRiff.writeUInt32LE(1000, 16);
      const chunkTooSmall = make(8, 8);
      chunkTooSmall.writeUInt32LE(1, 16);
      for (const bad of [riffZero, riffPastInput, chunkPastRiff, chunkTooSmall])
        expect(imageSize(bad, "image/webp")).toBeUndefined();
    }
    const trailing = Buffer.concat([vp8x(64, 32), Buffer.alloc(4)]);
    expect(imageSize(trailing, "image/webp")).toEqual({
      width: 64,
      height: 32,
    });
  });
});
