// Read-only version subprocess diagnosis. Never prints raw process output,
// environment, credentials, or runtime paths. No model/provider requests.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";

export async function diagnoseVersion(
  executable,
  args = ["--version"],
  options = {},
) {
  try {
    const { stdout, stderr } = await promisify(execFile)(executable, args, {
      timeout: 5000,
      maxBuffer: 4096,
      ...options,
    });
    const version = stdout.trim();
    return {
      stage: "version",
      category: /^\d+\.\d+\.\d+$/.test(version)
        ? "version-reported"
        : "unexpected-output",
      version: /^\d+\.\d+\.\d+$/.test(version) ? version : null,
      stderrPresent: !!stderr,
    };
  } catch (error) {
    const stderr = String(error.stderr ?? "");
    const category = /uv_cwd|uv_os_getcwd|ENOENT.*getcwd/.test(stderr)
      ? "working-directory-unavailable"
      : error.code === "ENOENT"
        ? "executable-not-found"
        : error.code === "EACCES"
          ? "executable-permission"
          : error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"
            ? "output-limit"
            : error.killed
              ? "timeout"
              : /env: node: No such file or directory/.test(stderr)
                ? "node-not-on-path"
                : /Cannot find (module|package)|ERR_MODULE_NOT_FOUND/.test(
                      stderr,
                    )
                  ? "dependency-missing"
                  : /SyntaxError|Unsupported.*Node|requires Node/.test(stderr)
                    ? "javascript-runtime-incompatible"
                    : "process-exit";
    return {
      stage: "version",
      category,
      exitCode: Number.isInteger(error.code) ? error.code : null,
      signal: error.signal ?? null,
    };
  }
}

if (
  process.argv[1] &&
  import.meta.url === new URL(`file://${resolve(process.argv[1])}`).href
) {
  const path = process.argv[2];
  if (!path) throw Error("Pass a reviewed local Pi entrypoint.");
  console.log(
    JSON.stringify({
      direct: await diagnoseVersion(path),
      pinnedNode: await diagnoseVersion(process.execPath, [path, "--version"]),
    }),
  );
}
