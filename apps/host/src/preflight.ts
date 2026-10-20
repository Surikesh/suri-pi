import { access, readFile, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { platform, arch, release } from "node:os";
import { dirname, join } from "node:path";

type StartupStage =
  | "platform"
  | "node"
  | "helper"
  | "sqlite"
  | "pty"
  | "assets"
  | "control"
  | "lock"
  | "storage"
  | "listener"
  | "child"
  | "readiness";

export type StartupFailure = {
  ok: false;
  stage: StartupStage;
  code: string;
  retryable: boolean;
  action: string;
};

type PreflightResult =
  | { ok: true; platform: string; architecture: string; node: string }
  | StartupFailure;

const supportedNode = "24.15.0";

export function startupFailure(
  stage: StartupStage,
  code: string,
  retryable: boolean,
  action: string,
): StartupFailure {
  return { ok: false, stage, code, retryable, action };
}

export class StartupBoundaryError extends Error {
  constructor(readonly detail: StartupFailure) {
    super(detail.code);
  }
}

export function classifyStartupError(stage: StartupStage): StartupFailure {
  const categories: Partial<
    Record<StartupStage, Omit<StartupFailure, "ok" | "stage">>
  > = {
    lock: {
      code: "HOST_LOCK_UNAVAILABLE",
      retryable: true,
      action: "Check whether a compatible Suri host already owns this profile.",
    },
    storage: {
      code: "STORAGE_OPEN_FAILED",
      retryable: false,
      action:
        "Check profile permissions and available storage without deleting user data.",
    },
    listener: {
      code: "LISTENER_BIND_FAILED",
      retryable: true,
      action:
        "Choose an unused loopback port or stop its known owning fixture.",
    },
    child: {
      code: "CHILD_EARLY_EXIT",
      retryable: true,
      action:
        "Inspect the bounded launch category and retry only after its cause is corrected.",
    },
    control: {
      code: "CONTROL_INVALID_RESPONSE",
      retryable: false,
      action:
        "Use the client matching the active Suri host; leave unknown services unchanged.",
    },
  };
  const category = categories[stage] ?? {
    code: "HOST_START_FAILED",
    retryable: false,
    action: "Correct the reported startup stage before retrying.",
  };
  return { ok: false, stage, ...category };
}

export async function preflight(options: {
  assets: string;
  helper: string;
  requireSupportedPlatform?: boolean;
  sqliteLoader?: () => Promise<{ default: typeof import("better-sqlite3") }>;
  ptyLoader?: () => Promise<typeof import("node-pty")>;
}): Promise<PreflightResult> {
  if (
    options.requireSupportedPlatform !== false &&
    (platform() !== "darwin" ||
      arch() !== "arm64" ||
      Number(release().split(".")[0]) < 23)
  ) {
    return startupFailure(
      "platform",
      "UNSUPPORTED_PLATFORM",
      false,
      "Use macOS 14 or newer on Apple silicon for this Local artifact.",
    );
  }
  if (process.versions.node !== supportedNode) {
    return startupFailure(
      "node",
      "UNSUPPORTED_NODE",
      false,
      `Run Suri with Node ${supportedNode}.`,
    );
  }
  try {
    await access(options.helper, constants.X_OK);
  } catch {
    return startupFailure(
      "helper",
      "HELPER_UNAVAILABLE",
      false,
      "Rebuild or reinstall the matching Suri release.",
    );
  }
  try {
    const sqlite = await (options.sqliteLoader?.() ?? import("better-sqlite3"));
    const Database = sqlite.default;
    const db = new Database(":memory:");
    db.prepare("select 1").get();
    db.close();
  } catch {
    return startupFailure(
      "sqlite",
      "SQLITE_ABI_UNAVAILABLE",
      false,
      "Install the reviewed native dependencies for Node 24.15.0.",
    );
  }
  try {
    const pty = await (options.ptyLoader?.() ?? import("node-pty"));
    if (typeof pty.spawn !== "function") throw new Error("invalid pty module");
  } catch {
    return startupFailure(
      "pty",
      "PTY_ABI_UNAVAILABLE",
      false,
      "Install the reviewed native dependencies for Node 24.15.0.",
    );
  }
  try {
    const html = await readFile(join(options.assets, "index.html"), "utf8");
    if (!html.includes("<script")) throw new Error("invalid asset entry");
  } catch {
    return startupFailure(
      "assets",
      "ASSET_MANIFEST_INVALID",
      false,
      "Rebuild or reinstall the matching Suri release.",
    );
  }
  return {
    ok: true,
    platform: platform(),
    architecture: arch(),
    node: process.versions.node,
  };
}

export async function writeStartupFailure(
  path: string | undefined,
  result: StartupFailure,
) {
  if (!path) return;
  try {
    await writeFile(path, JSON.stringify(result) + "\n", { mode: 0o600 });
  } catch {
    // The parent still has timeout categorization if the private channel is unavailable.
  }
}

export function startupStatusPath(root: string, id: string) {
  return join(dirname(join(root, "run", "placeholder")), `startup-${id}.json`);
}
