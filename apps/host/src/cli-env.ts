import { join, resolve, dirname } from "node:path";
import { homedir, platform } from "node:os";
import { fileURLToPath } from "node:url";
import { type StartupFailure } from "./preflight.js";
const defaultDataRoot =
  platform() === "darwin"
    ? join(homedir(), "Library/Application Support/Suri Pi")
    : join(
        process.env.XDG_DATA_HOME ?? join(homedir(), ".local/share"),
        "suri-pi",
      );
export const root = process.env.SURI_DATA_DIR ?? defaultDataRoot;
export const repo = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../..",
);
export const assets = process.env.SURI_ASSETS_DIR ?? join(repo, "dist/ui");
export const helper = join(repo, "dist/native/suri-helper");

export class CliFailure extends Error {
  constructor(readonly detail: StartupFailure) {
    super(detail.code);
  }
}

export function fail(
  stage: StartupFailure["stage"],
  code: string,
  retryable: boolean,
  action: string,
): never {
  throw new CliFailure({ ok: false, stage, code, retryable, action });
}
