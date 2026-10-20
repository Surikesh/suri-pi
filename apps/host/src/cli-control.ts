import { connect } from "node:net";
import { join } from "node:path";
import { openBrowser } from "./browser-launcher.js";
import {
  classifyStartupError,
  startupFailure,
  type StartupFailure,
} from "./preflight.js";
import { CliFailure, fail } from "./cli-env.js";

// Accepts any health-shaped payload; every field is checked at runtime below.
type HealthInput = {
  product?: unknown;
  protocol?: unknown;
  uiContract?: unknown;
  storageSchema?: unknown;
  capabilities?: unknown;
  instanceId?: unknown;
  lifecycle?: unknown;
  [field: string]: unknown;
};

export function assertCompatibleHealth(value: HealthInput | undefined) {
  if (
    value?.product !== "suri-pi" ||
    value?.protocol !== 1 ||
    ![1, 2].includes(value?.uiContract as number) ||
    value?.storageSchema !== 1 ||
    !Array.isArray(value?.capabilities) ||
    !(value.capabilities as unknown[]).includes("local-browser") ||
    typeof value?.instanceId !== "string" ||
    value.lifecycle !== "running"
  )
    fail(
      "control",
      "INCOMPATIBLE_HOST",
      false,
      "Use the client matching the active Suri host; it was left running unchanged.",
    );
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- frozen characterization tests dereference control replies dynamically (work.blockers, evolving `let health`); a structural view would not typecheck them
export async function control(root: string, p: unknown): Promise<any> {
  return new Promise((resolve, reject) => {
    const s = connect(join(root, "run/control.sock"));
    let b = "";
    let settled = false;
    const rejectOnce = (detail: StartupFailure) => {
      if (settled) return;
      settled = true;
      reject(new CliFailure(detail));
    };
    s.on("connect", () => s.write(JSON.stringify(p) + "\n"));
    s.on("data", (x) => {
      b += x;
      if (b.length > 65536) {
        rejectOnce(classifyStartupError("control"));
        s.destroy();
      }
    });
    s.on("end", () => {
      if (settled) return;
      try {
        const value = JSON.parse(b);
        if (value?.error === "HOST_STOPPING")
          return rejectOnce(
            startupFailure(
              "control",
              "HOST_STOPPING",
              true,
              "Wait for the owned host shutdown to complete before reconnecting.",
            ),
          );
        if (
          [
            "UPDATE_STATE_CORRUPT",
            "STORAGE_UNAVAILABLE",
            "INTERNAL_UNCLASSIFIED",
            "CHECKOUT_CHANGED",
            "UPDATE_CONFLICT",
            "HOST_BUSY",
            "HOST_IDENTITY_CHANGED",
            "MIGRATION_APPROVAL_MISMATCH",
            "MIGRATION_APPROVAL_EXPIRED",
            "MIGRATION_ALREADY_PENDING",
          ].includes(value?.error)
        )
          return rejectOnce(
            startupFailure(
              "control",
              value.error,
              false,
              value.error === "HOST_BUSY"
                ? "Protected work appeared before admission; the host remains running."
                : value.error === "HOST_IDENTITY_CHANGED"
                  ? "The observed host identity changed; the host remains untouched."
                  : "Update status is unavailable. Preserve the running host and inspect the update-state boundary; do not retry activation.",
            ),
          );
        if (value?.error)
          return rejectOnce(
            /^[A-Z][A-Z0-9_]{1,79}$/.test(value.error)
              ? startupFailure(
                  "control",
                  value.error,
                  false,
                  "The bounded control operation was refused; inspect its exact category before retrying.",
                )
              : classifyStartupError("control"),
          );
        settled = true;
        resolve(value);
      } catch {
        rejectOnce(classifyStartupError("control"));
      }
    });
    s.on("error", () =>
      rejectOnce(
        startupFailure(
          "control",
          "CONTROL_UNAVAILABLE",
          true,
          "Start a compatible Suri host for this profile.",
        ),
      ),
    );
    s.setTimeout(5000, () => {
      rejectOnce(
        startupFailure(
          "control",
          "CONTROL_TIMEOUT",
          true,
          "Check the known local host lifecycle before retrying.",
        ),
      );
      s.destroy();
    });
  });
}

export type ShutdownReceipt = {
  status?: unknown;
  result?: { stopping?: unknown; instanceId?: unknown };
  error?: { code?: unknown; retryable?: unknown };
};

export function assertShutdownReceipt(
  receipt: ShutdownReceipt | undefined,
  instanceId: string,
) {
  if (
    receipt?.status !== "completed" ||
    receipt?.result?.stopping !== true ||
    receipt?.result?.instanceId !== instanceId
  )
    fail(
      "control",
      receipt?.error?.code === "HOST_BUSY" ? "HOST_BUSY" : "SHUTDOWN_REJECTED",
      receipt?.error?.retryable === true,
      receipt?.error?.code === "HOST_BUSY"
        ? "Finish or stop active work before restarting."
        : "Keep the current host running and inspect its bounded shutdown receipt.",
    );
}
export async function openWorkingBrowser(
  root: string,
  url: string,
  newTab: boolean,
) {
  try {
    await openBrowser(url, {
      newTab,
      checkpoint: async (clientInstanceId) =>
        (await control(root, { type: "browser-rendezvous", clientInstanceId }))
          .checkpointed === true,
    });
  } catch {
    fail(
      "control",
      "BROWSER_REUSE_UNAVAILABLE",
      false,
      "Existing tabs were preserved. Use open --new-tab only if you explicitly want another tab.",
    );
  }
}
