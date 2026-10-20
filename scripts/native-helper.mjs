import { execFileSync } from "node:child_process";
import { join } from "node:path";

// The compiler is /usr/bin/clang on macOS and cc elsewhere. Override it with CC.
// To build against a specific macOS SDK set SDKROOT (clang and xcrun honor it;
// see `man xcrun` and README "Building the native helper"). Nothing is
// substituted automatically.
function compiler() {
  return (
    process.env.CC ?? (process.platform === "darwin" ? "/usr/bin/clang" : "cc")
  );
}

/** Compile one C file. Honors CC and SDKROOT from the environment. */
export function compileC(
  source,
  output,
  { cwd = process.cwd(), flags = [] } = {},
) {
  const cc = compiler();
  try {
    return execFileSync(cc, [...flags, source, "-o", output], {
      cwd,
      stdio: "pipe",
      timeout: 60000,
    });
  } catch (error) {
    process.stderr.write(error.stderr ?? "");
    process.stderr.write(
      `Native helper compile failed with ${cc} (SDKROOT=${process.env.SDKROOT ?? "unset"}). ` +
        "If the linker reports a malformed SDK file, set SDKROOT to a working SDK, " +
        "for example SDKROOT=$(ls -d /Library/Developer/CommandLineTools/SDKs/MacOSX*.sdk | tail -1), " +
        'or set CC. See README "Building the native helper".\n',
    );
    throw error;
  }
}

/** Compile native/suri-helper.c into output. */
export function compileHelper(
  output,
  { cwd = process.cwd(), flags = [] } = {},
) {
  compileC(join(cwd, "native/suri-helper.c"), output, { cwd, flags });
}
