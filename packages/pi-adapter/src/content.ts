import type { Block, Data } from "../../protocol/src/index.js";

export function displayText(value: unknown) {
  return String(value ?? "")
    .replace(/\u001B\][^\u0007]*(?:\u0007|\u001B\\)/g, "")
    .replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, "");
}

export function content(
  raw: unknown,
  prefix: string,
  image?: (data: string, mime: string) => string,
): Block[] {
  if (typeof raw === "string")
    return [{ kind: "text", id: prefix, text: displayText(raw) }];
  if (!Array.isArray(raw)) return [];
  return raw.map((b: Data, i) => {
    const id = `${prefix}:${i}`;
    switch (b.type) {
      case "text":
        return { kind: "text", id, text: displayText(b.text) };
      case "thinking":
        return { kind: "thinking", id, text: displayText(b.thinking) };
      case "toolCall":
        return {
          kind: "toolCall",
          id,
          callId: String(b.id),
          name: String(b.name),
          arguments:
            b.arguments && typeof b.arguments === "object" ? b.arguments : {},
        };
      case "image":
        if (
          image &&
          typeof b.data === "string" &&
          typeof b.mimeType === "string"
        )
          return {
            kind: "image",
            id,
            artifactId: image(b.data, b.mimeType),
            mime: b.mimeType,
          };
        return {
          kind: "unknown",
          id,
          text: "Image output requires artifact capture.",
        };
      default:
        return { kind: "unknown", id, text: "Unsupported content" };
    }
  });
}
