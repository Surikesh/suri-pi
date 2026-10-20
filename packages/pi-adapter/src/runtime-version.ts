import { execFile } from "node:child_process";
import { promisify } from "node:util";

type VersionFailure =
  | "executable-not-found"
  | "permission-denied"
  | "working-directory-unavailable"
  | "node-not-on-path"
  | "timeout"
  | "output-limit"
  | "process-exit"
  | "unexpected-output";

export function versionFailure(error: {
  code?: unknown;
  killed?: boolean;
  stderr?: unknown;
}): VersionFailure {
  const stderr = String(error.stderr ?? "");
  if (/uv_cwd|uv_os_getcwd|ENOENT.*getcwd/.test(stderr))
    return "working-directory-unavailable";
  if (/env: node: No such file or directory/.test(stderr))
    return "node-not-on-path";
  if (error.code === "ENOENT") return "executable-not-found";
  if (error.code === "EACCES") return "permission-denied";
  if (error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") return "output-limit";
  if (error.killed) return "timeout";
  return "process-exit";
}

// A host may outlive replacement/removal of its launch directory. Never let a
// version subprocess inherit that directory; Pi calls process.cwd() at startup.
// The caller supplies the already verified, canonical runtime package root.
export async function runtimeVersion(
  executable: string,
  packageRoot: string,
): Promise<
  { ok: true; version: string } | { ok: false; category: VersionFailure }
> {
  try {
    const { stdout } = await promisify(execFile)(executable, ["--version"], {
      cwd: packageRoot,
      timeout: 5000,
      maxBuffer: 4096,
    });
    const version = stdout.trim();
    return /^\d+\.\d+\.\d+$/.test(version)
      ? { ok: true, version }
      : { ok: false, category: "unexpected-output" };
  } catch (error) {
    return {
      ok: false,
      category: versionFailure(error as Parameters<typeof versionFailure>[0]),
    };
  }
}
