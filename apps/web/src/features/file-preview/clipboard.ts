import type { Data } from "../../../../../packages/protocol/src/index.js";
export async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch {
    // The async clipboard API is unavailable or denied; fall back to the textarea copy below.
  }
  const field = document.createElement("textarea");
  field.value = text;
  field.readOnly = true;
  field.style.position = "fixed";
  field.style.opacity = "0";
  document.body.append(field);
  field.select();
  const copied = document.execCommand("copy");
  field.remove();
  if (!copied) throw Error("Clipboard access is unavailable.");
}

export function saveFile(file: Data, path: string) {
  if (file.truncated)
    throw Error("This file exceeds the 1 MiB download limit.");
  const bytes =
    file.encoding === "base64"
      ? Uint8Array.from(atob(file.content), (c) => c.charCodeAt(0))
      : file.content;
  const url = URL.createObjectURL(
    new Blob([bytes], { type: "application/octet-stream" }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = path.split("/").pop() ?? "file";
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
