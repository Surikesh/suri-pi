import { spawn } from "node:child_process";
import { chmod, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { ReviewQueueRuntimeError } from "./review-queue-error.js";
import type { QueueAuthority } from "./review-queue-types.js";

export async function makeReadonly(root: string): Promise<void> {
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) await makeReadonly(path);
    else await chmod(path, 0o400);
  }
  await chmod(root, 0o500);
}
export function contains(root: string, child: string) {
  const rel = relative(root, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}
export function safeRelative(target: string) {
  if (
    !target ||
    isAbsolute(target) ||
    target.includes("\0") ||
    target.includes("\\")
  )
    throw new ReviewQueueRuntimeError(
      "path_escape",
      "Path escaped the granted root.",
    );
  const normalized = relative("/root", resolve("/root", target));
  if (!normalized || normalized.startsWith("..") || isAbsolute(normalized))
    throw new ReviewQueueRuntimeError(
      "path_escape",
      "Path escaped the granted root.",
    );
  return normalized;
}
export async function canonicalAuthority(
  authority: QueueAuthority,
): Promise<QueueAuthority> {
  return { ...authority, repository: await realpath(authority.repository) };
}
export function runBounded(command: string, args: string[], stdin?: Buffer) {
  return new Promise<{ code: number; stdout: Buffer; stderr: Buffer }>(
    (resolveResult, reject) => {
      const child = spawn(command, args, {
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let outBytes = 0;
      let errBytes = 0;
      child.stdout.on("data", (chunk: Buffer) => {
        outBytes += chunk.length;
        if (outBytes <= 1024 * 1024 + 1) stdout.push(chunk);
      });
      child.stderr.on("data", (chunk: Buffer) => {
        errBytes += chunk.length;
        if (errBytes <= 64 * 1024) stderr.push(chunk);
      });
      child.once("error", reject);
      child.once("close", (code) =>
        resolveResult({
          code: code ?? 1,
          stdout: Buffer.concat(stdout),
          stderr: Buffer.concat(stderr),
        }),
      );
      // A child that exits without reading its stdin makes the write fail with
      // EPIPE (seen on Linux); the exit code and stderr already report the outcome.
      child.stdin.on("error", () => undefined);
      child.stdin.end(stdin);
    },
  );
}
