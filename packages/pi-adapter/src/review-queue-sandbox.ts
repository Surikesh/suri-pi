import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { ReviewQueueRuntimeError } from "./review-queue-error.js";

export function seatbeltProfile(repository: string, executable: string) {
  const quote = (value: string) =>
    value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
  const root = quote(repository);
  const binary = quote(executable);
  return `(version 1)\n(deny default)\n(allow process-exec (literal "${binary}"))\n(deny process-fork)\n(allow sysctl-read)\n(allow file-read* (literal "/") (literal "${binary}") (subpath "/System") (subpath "/usr/lib") (subpath "${root}"))\n(allow file-write* (subpath "${root}"))\n(deny network*)`;
}

const deniedExecutablePaths = [
  "/bin/sh",
  "/bin/bash",
  "/bin/zsh",
  "/bin/csh",
  "/bin/tcsh",
  "/usr/bin/env",
  "/usr/bin/clang",
  "/usr/bin/clang++",
  "/usr/bin/git",
  "/usr/bin/xcrun",
  "/usr/bin/xcodebuild",
  "/usr/bin/open",
  "/usr/bin/xargs",
  "/usr/bin/find",
  "/usr/bin/make",
  "/usr/bin/python3",
  "/usr/bin/perl",
  "/usr/bin/ruby",
  "/usr/bin/php",
  "/usr/bin/osascript",
  "/usr/bin/swift",
  "/usr/bin/java",
  "/usr/bin/script",
  process.execPath,
];
type DeniedExecutableIdentity = {
  path: string;
  dev: bigint;
  ino: bigint;
  size: bigint;
  digest?: Promise<string>;
};
let deniedExecutableIdentities: Promise<DeniedExecutableIdentity[]> | undefined;
async function deniedIdentities() {
  return (deniedExecutableIdentities ??= Promise.all(
    deniedExecutablePaths.map(async (path) => {
      // A denied path that does not exist on this machine has no identity to compare.
      const canonical = await realpath(path).catch(() => "");
      if (!canonical) return undefined;
      // A denied path that cannot be opened has no identity to compare.
      const handle = await open(
        canonical,
        constants.O_RDONLY | constants.O_NOFOLLOW,
      ).catch(() => undefined);
      if (!handle) return undefined;
      try {
        const stat = await handle.stat({ bigint: true });
        return {
          path: canonical,
          dev: stat.dev,
          ino: stat.ino,
          size: stat.size,
        };
      } finally {
        await handle.close();
      }
    }),
  ).then((values) =>
    values.filter((value): value is DeniedExecutableIdentity => !!value),
  ));
}
async function deniedExecutable(identity: {
  dev: bigint;
  ino: bigint;
  size: bigint;
  digest: string;
}) {
  for (const candidate of await deniedIdentities()) {
    if (candidate.dev === identity.dev && candidate.ino === identity.ino)
      return true;
    if (candidate.size !== identity.size) continue;
    candidate.digest ??= open(
      candidate.path,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    ).then(async (handle) => {
      try {
        return createHash("sha256")
          .update(await handle.readFile())
          .digest("hex");
      } finally {
        await handle.close();
      }
    });
    if ((await candidate.digest) === identity.digest) return true;
  }
  return false;
}
export async function assertAdmittedExecutable(executable: string) {
  if (!executable)
    throw new ReviewQueueRuntimeError(
      "process_denied",
      "Shells, interpreters, launchers, and command builders are not admitted.",
    );
  // An unopenable executable (undefined) is denied right below.
  const handle = await open(
    executable,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  ).catch(() => undefined);
  if (!handle)
    throw new ReviewQueueRuntimeError(
      "process_denied",
      "Executable is unavailable.",
    );
  try {
    const stat = await handle.stat({ bigint: true });
    const bytes = await handle.readFile();
    const magic = bytes.subarray(0, 4).toString("hex");
    const identity = {
      dev: stat.dev,
      ino: stat.ino,
      size: stat.size,
      digest: createHash("sha256").update(bytes).digest("hex"),
    };
    const denied = await deniedExecutable(identity);
    if (
      !stat.isFile() ||
      !(stat.mode & 0o111n) ||
      ![
        "feedface",
        "cefaedfe",
        "feedfacf",
        "cffaedfe",
        "cafebabe",
        "bebafeca",
      ].includes(magic) ||
      denied
    )
      throw new ReviewQueueRuntimeError(
        "process_denied",
        "Only explicitly admitted direct Mach-O binaries are available.",
      );
  } finally {
    await handle.close();
  }
}
