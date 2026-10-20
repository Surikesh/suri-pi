import type { Data } from "../../../../packages/protocol/src/index.js";
import { authenticatedFetch, getCsrf } from "./internal.js";
export async function upload(
  file: File,
  sessionId: string,
  kind = "attachment",
): Promise<Data> {
  window.suriUploadsPending = (window.suriUploadsPending ?? 0) + 1;
  try {
    return await uploadNow(file, sessionId, kind);
  } finally {
    window.suriUploadsPending--;
  }
}
async function uploadNow(
  file: File,
  sessionId: string,
  kind = "attachment",
): Promise<Data> {
  const r = await authenticatedFetch("/v1/attachments", {
    method: "POST",
    headers: {
      "X-Suri-Csrf": getCsrf(),
      "Content-Type": file.type || "text/plain",
      "X-Suri-Name": encodeURIComponent(file.name),
      "X-Suri-Kind": kind,
      "X-Suri-Session": sessionId,
    },
    body: file,
  });
  const data = await r.json();
  if (!r.ok) throw Error(data.error?.message ?? "Upload failed.");
  return data;
}

export async function uploadHistory(file: File): Promise<Data> {
  if (file.size > 32 * 1048576) throw Error("History exceeds 32 MiB.");
  const response = await authenticatedFetch("/v1/import-files", {
    method: "POST",
    headers: {
      "X-Suri-Csrf": getCsrf(),
      "X-Suri-Name": encodeURIComponent(file.name),
      "Content-Type": "application/octet-stream",
    },
    body: file,
  });
  const result = await response.json();
  if (!response.ok)
    throw Error(result.error?.message ?? "History upload failed.");
  return result;
}
