import { SuriError } from "../../../packages/protocol/src/index.js";
export function safePath(path: unknown): string {
  if (
    typeof path !== "string" ||
    path.includes("\0") ||
    path.includes("\\") ||
    path.startsWith("/") ||
    /^[a-z]:/i.test(path) ||
    path.split("/").includes("..")
  )
    throw new SuriError("PATH_DENIED", "Choose a path inside this workspace.");
  return path || ".";
}
