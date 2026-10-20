import { existsSync, rmSync } from "node:fs";
import { writeFile, readFile, mkdir, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { SuriError, type Data } from "../../../packages/protocol/src/index.js";
import { Storage } from "./storage.js";
import { imageSize } from "./image-size.js";
export class Assets {
  /** Row/file components this attempt created, per not-yet-referenced asset. */
  private fresh = new WeakMap<object, { row: boolean; file: boolean }>();
  constructor(private store: Storage) {}
  private hasRow(id: string) {
    try {
      this.store.get("asset", id);
      return true;
    } catch {
      return false;
    }
  }
  /** Removes only the row and/or file this attempt created; pre-existing parts stay. */
  discard(asset: Data) {
    const own = this.fresh.get(asset);
    this.fresh.delete(asset);
    if (!own) return;
    if (own.row)
      try {
        this.store.remove("asset", asset.id);
      } catch {
        // Best effort: the row is only removed while storage is still writable.
      }
    if (own.file)
      rmSync(join(this.store.root, "assets", asset.id), { force: true });
  }
  /** Head of a session stream; lets callers tell if an event committed. */
  head(sessionId: string) {
    return this.store.head(`session:${sessionId}`);
  }
  async upload(
    bytes: Buffer,
    name: string,
    mime: string,
    kind: string,
    sessionId: string,
    requestedId?: string,
  ) {
    if (kind !== "icon") this.store.get("session", sessionId);
    if (!["attachment", "icon"].includes(kind) || name.length > 200)
      throw new SuriError("VALIDATION", "Invalid asset.");
    if (kind === "icon" && mime === "image/svg+xml") {
      if (bytes.length > 1048576)
        throw new SuriError(
          "LIMIT_EXCEEDED",
          "Attachment exceeds the size limit.",
        );
      const source = bytes.toString("utf8");
      if (
        Buffer.from(source).compare(bytes) !== 0 ||
        !/<svg(?:\s|>)/i.test(source) ||
        /<(?:script|foreignObject)\b|<!DOCTYPE|<!ENTITY|<\?xml-stylesheet|@import|\burl\s*\(|\bon[a-z]+\s*=|\b(?:href|src)\s*=\s*["'](?!#|data:image\/)/i.test(
          source,
        )
      )
        throw new SuriError(
          "VALIDATION",
          "SVG icon contains unsupported content.",
        );
      await mkdir(join(this.store.root, "assets"), {
        recursive: true,
        mode: 0o700,
      });
      const temporaryId = randomUUID();
      const input = join(this.store.root, "assets", `.${temporaryId}.svg`);
      const output = join(this.store.root, "assets", `.${temporaryId}.png`);
      try {
        await writeFile(input, bytes, { mode: 0o600 });
        await promisify(execFile)(
          "/usr/bin/sips",
          ["-s", "format", "png", "-z", "60", "60", input, "--out", output],
          { timeout: 5000, maxBuffer: 4096 },
        );
        if ((await stat(output)).size > 1048576)
          throw new SuriError(
            "LIMIT_EXCEEDED",
            "Converted icon exceeds the size limit.",
          );
        bytes = await readFile(output);
        name = name.replace(/\.svg$/i, ".png");
        mime = "image/png";
      } catch (error) {
        if (error instanceof SuriError) throw error;
        throw new SuriError("VALIDATION", "SVG icon could not be decoded.");
      } finally {
        await Promise.all([
          // Best effort: a temp file that is already gone needs no cleanup.
          unlink(input).catch(() => undefined),
          unlink(output).catch(() => undefined),
        ]);
      }
    }
    const image = ["image/png", "image/jpeg", "image/webp"].includes(mime);
    if (kind === "icon" && !image)
      throw new SuriError(
        "VALIDATION",
        "Icons must be PNG, JPEG or WebP images.",
      );
    if (
      image &&
      !(
        (mime === "image/png" &&
          bytes
            .subarray(0, 8)
            .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) ||
        (mime === "image/jpeg" && bytes[0] === 255 && bytes[1] === 216) ||
        (mime === "image/webp" &&
          bytes.subarray(0, 4).toString() === "RIFF" &&
          bytes.subarray(8, 12).toString() === "WEBP")
      )
    )
      throw new SuriError(
        "VALIDATION",
        "Image bytes do not match the declared format.",
      );
    if (!image && !mime.startsWith("text/"))
      throw new SuriError(
        "VALIDATION",
        "Only raster images and text attachments are supported.",
      );
    if (bytes.length > (kind === "icon" || !image ? 1048576 : 10 * 1048576))
      throw new SuriError(
        "LIMIT_EXCEEDED",
        "Attachment exceeds the size limit.",
      );
    if (
      !image &&
      (bytes.includes(0) ||
        Buffer.from(bytes.toString("utf8")).compare(bytes) !== 0)
    )
      throw new SuriError(
        "VALIDATION",
        "Text attachments must contain UTF-8 text.",
      );
    const id = requestedId ?? randomUUID();
    const file = join(this.store.root, "assets", id);
    await mkdir(join(this.store.root, "assets"), {
      recursive: true,
      mode: 0o700,
    });
    const ownFile = !existsSync(file);
    const ownRow = !this.hasRow(id);
    try {
      await writeFile(file, bytes, { mode: 0o600 });
      let width: number | undefined, height: number | undefined;
      if (image) {
        try {
          if (process.platform === "darwin") {
            const { stdout } = await promisify(execFile)(
              "/usr/bin/sips",
              ["-g", "pixelWidth", "-g", "pixelHeight", file],
              { timeout: 5000, maxBuffer: 4096 },
            );
            width = Number(stdout.match(/pixelWidth:\s*(\d+)/)?.[1]);
            height = Number(stdout.match(/pixelHeight:\s*(\d+)/)?.[1]);
          } else ({ width, height } = imageSize(bytes, mime) ?? {});
          if (
            !width ||
            !height ||
            width * height > 40000000 ||
            (kind === "icon" && (width > 512 || height > 512))
          )
            throw Error();
        } catch {
          throw new SuriError(
            "VALIDATION",
            "Image could not be decoded or exceeds the dimensions limit.",
          );
        }
      }
      const asset = this.store.put("asset", {
        id,
        name,
        mime,
        kind,
        sessionId,
        bytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        width,
        height,
      });
      this.fresh.set(asset, { row: ownRow, file: ownFile });
      return asset;
    } catch (error) {
      if (ownFile) rmSync(file, { force: true });
      throw error;
    }
  }
  async output(
    text: string,
    sessionId: string,
    options: { name?: string; mime?: string } = {},
  ) {
    this.store.get("session", sessionId);
    const bytes = Buffer.from(text);
    if (bytes.length > 32 * 1048576)
      throw new SuriError("LIMIT_EXCEEDED", "Output artifact exceeds 32 MiB.");
    const id = randomUUID();
    await mkdir(join(this.store.root, "assets"), {
      recursive: true,
      mode: 0o700,
    });
    const file = join(this.store.root, "assets", id);
    try {
      await writeFile(file, bytes, { mode: 0o600 });
      const asset = this.store.put("asset", {
        id,
        sessionId,
        name: options.name ?? "Complete Pi output",
        mime: options.mime ?? "text/plain",
        kind: "output",
        bytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      });
      this.fresh.set(asset, { row: true, file: true });
      return asset;
    } catch (error) {
      rmSync(file, { force: true });
      throw error;
    }
  }
  async read(id: string, sessionId?: string) {
    const asset = this.store.get("asset", id);
    if (sessionId && asset.sessionId !== sessionId)
      throw new SuriError(
        "PATH_DENIED",
        "Attachment belongs to another session.",
      );
    try {
      return {
        asset,
        bytes: await readFile(join(this.store.root, "assets", id)),
      };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
      throw new SuriError(
        "ARTIFACT_UNAVAILABLE",
        "The attachment is no longer available.",
      );
    }
  }
  async prompt(ids: unknown, sessionId: string, text: string) {
    if (!Array.isArray(ids) || ids.length > 8)
      throw new SuriError("VALIDATION", "Invalid attachments.");
    const images: Data[] = [];
    let total = 0;
    for (const id of ids) {
      if (typeof id !== "string")
        throw new SuriError("VALIDATION", "Invalid attachment id.");
      const { asset, bytes } = await this.read(id, sessionId);
      total += bytes.length;
      if (total > 20 * 1048576)
        throw new SuriError(
          "LIMIT_EXCEEDED",
          "Combined attachments exceed 20 MiB.",
        );
      if (asset.mime.startsWith("image/"))
        images.push({
          type: "image",
          data: bytes.toString("base64"),
          mimeType: asset.mime,
        });
      else
        text += `\n\n--- Attached text: ${asset.name} ---\n${bytes.toString("utf8")}\n--- End attachment ---`;
    }
    if (images.length > 4 || Buffer.byteLength(text) > 1048576)
      throw new SuriError(
        "LIMIT_EXCEEDED",
        "Message or image count exceeds the limit.",
      );
    return { message: text, ...(images.length ? { images } : {}) };
  }
}
