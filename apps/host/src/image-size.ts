// Pure-JS pixel size probe for PNG, JPEG and WebP. macOS reads sizes with
// /usr/bin/sips; other platforms have no such tool, so this is the fallback.
// Structurally truncated or inconsistent headers yield undefined, which the
// caller treats like a failed decode.
interface ImageSize {
  width: number;
  height: number;
}

const valid = (width: number, height: number): ImageSize | undefined =>
  width > 0 && height > 0 ? { width, height } : undefined;

function png(b: Buffer): ImageSize | undefined {
  // Signature (8), IHDR length (4, = 13), "IHDR" (4), data (13), CRC (4).
  if (b.length < 33 || b.readUInt32BE(8) !== 13) return;
  if (b.toString("latin1", 12, 16) !== "IHDR") return;
  return valid(b.readUInt32BE(16), b.readUInt32BE(20));
}

function jpeg(b: Buffer): ImageSize | undefined {
  let at = 2;
  while (at + 2 <= b.length) {
    if (b[at] !== 0xff) return;
    const marker = b[at + 1] ?? 0;
    if (marker === 0xff) {
      at += 1;
      continue;
    }
    if (
      marker === 0xd8 ||
      marker === 0x01 ||
      (marker >= 0xd0 && marker <= 0xd7)
    ) {
      at += 2;
      continue;
    }
    if (at + 4 > b.length) return;
    const length = b.readUInt16BE(at + 2);
    // The segment must fit in the input and hold at least its length field.
    if (length < 2 || at + 2 + length > b.length) return;
    // SOF0..SOF15 except DHT (c4), JPG (c8) and DAC (cc) carry the frame size:
    // length, precision, height, width, components.
    if (
      marker >= 0xc0 &&
      marker <= 0xcf &&
      marker !== 0xc4 &&
      marker !== 0xc8 &&
      marker !== 0xcc
    )
      return length >= 8
        ? valid(b.readUInt16BE(at + 7), b.readUInt16BE(at + 5))
        : undefined;
    at += 2 + length;
  }
  return;
}

function webp(b: Buffer): ImageSize | undefined {
  if (b.length < 16 || b.toString("latin1", 0, 4) !== "RIFF") return;
  if (b.toString("latin1", 8, 12) !== "WEBP") return;
  const kind = b.toString("latin1", 12, 16);
  // The RIFF size covers everything after its own field; the first chunk must
  // fit inside it, and both must fit inside the input.
  const riffEnd = 8 + b.readUInt32LE(4);
  const chunk = b.length >= 20 ? b.readUInt32LE(16) : 0;
  if (riffEnd > b.length || chunk < (kind === "VP8L" ? 5 : 10)) return;
  if (20 + chunk > riffEnd) return;
  if (kind === "VP8X" && b.length >= 30)
    return valid(b.readUIntLE(24, 3) + 1, b.readUIntLE(27, 3) + 1);
  if (kind === "VP8L" && b.length >= 25 && b[20] === 0x2f) {
    const bits = b.readUInt32LE(21);
    return valid((bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1);
  }
  if (
    kind === "VP8 " &&
    b.length >= 30 &&
    b[23] === 0x9d &&
    b[24] === 0x01 &&
    b[25] === 0x2a
  )
    return valid(b.readUInt16LE(26) & 0x3fff, b.readUInt16LE(28) & 0x3fff);
  return;
}

export function imageSize(bytes: Buffer, mime: string): ImageSize | undefined {
  if (mime === "image/png") return png(bytes);
  if (mime === "image/jpeg") return jpeg(bytes);
  if (mime === "image/webp") return webp(bytes);
  return;
}
