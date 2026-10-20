import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { launchRetained, launchVerifiedHost } from "./retained-hosts.js";
import { CliFailure, fail, helper, root } from "./cli-env.js";
import { control } from "./cli-control.js";
import { migrateLegacyHost } from "./cli-migrate.js";

export async function runUpdates(args: string[]) {
  if (args.length === 1 && args[0] === "diagnostics") {
    console.log(
      JSON.stringify(
        await (await import("./update-diagnostics.js")).updateDiagnostics(root),
      ),
    );
    return;
  }
  if (args.length === 1 && args[0] === "import") {
    const { UpdateStateStore } = await import("./update-state.js");
    const { ImmutableArtifacts } = await import("./update-artifacts.js");
    const { UpdateDiscovery } = await import("./update-discovery.js");
    try {
      const state = (await UpdateStateStore.load(root)).snapshot();
      if (!state.association)
        fail(
          "control",
          "CHECKOUT_ASSOCIATION_REQUIRED",
          false,
          "Associate the explicit checkout with the running host before importing artifacts.",
        );
      console.log(
        JSON.stringify(
          await new UpdateDiscovery(
            new ImmutableArtifacts(root, helper),
          ).reconcile(state.association!),
        ),
      );
      return;
    } catch (error) {
      if (error instanceof CliFailure) throw error;
      const code =
        error instanceof Error && "code" in error
          ? String(error.code)
          : "UPDATE_IMPORT_STATE_UNAVAILABLE";
      fail(
        "control",
        code,
        false,
        "Artifact import could not read the associated profile state; no host was started or stopped.",
      );
    }
  }
  if (
    args.length === 4 &&
    args[0] === "migrate" &&
    /^[a-f0-9]{64}$/.test(args[1]) &&
    /^[a-f0-9]{64}$/.test(args[2]) &&
    args[3] === "--confirm"
  ) {
    await migrateLegacyHost(args[1], args[2]);
    return;
  }
  if (
    args.length === 4 &&
    args[0] === "start-retained" &&
    /^[a-f0-9]{64}$/.test(args[1]) &&
    /^[a-f0-9]{64}$/.test(args[2]) &&
    args[3] === "--confirm"
  ) {
    try {
      await control(root, { type: "health" });
      fail(
        "control",
        "HOST_PRESENT",
        false,
        "A retained launch never replaces a running host. Finish protected work and use guarded shutdown first.",
      );
    } catch (error) {
      if (!(
        error instanceof CliFailure &&
        error.detail.code === "CONTROL_UNAVAILABLE"
      ))
        throw error;
    }
    const endpoint = await readFile(join(root, "run/endpoint.json"), "utf8")
      .then(JSON.parse)
      .catch((error) => {
        fail(
          "control",
          error.code === "ENOENT"
            ? "CONTROL_ENDPOINT_MISSING"
            : "CONTROL_ENDPOINT_INVALID",
          false,
          "The exact retained launch address is unavailable; no host was started.",
        );
      });
    try {
      await launchVerifiedHost(root, args[1], args[2], endpoint.origin, () =>
        control(root, { type: "health" }),
      );
      const grant = await control(root, { type: "bootstrap" });
      if (grant.origin !== endpoint.origin)
        fail(
          "readiness",
          "HOST_ADDRESS_CHANGED",
          false,
          "Retained launch must keep the prior profile address.",
        );
      const response = await fetch(grant.origin + "/v1/bootstrap", {
        method: "POST",
        headers: { Origin: grant.origin, "Content-Type": "application/json" },
        body: JSON.stringify({ nonce: grant.nonce }),
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok)
        fail(
          "readiness",
          "HOST_REBOOTSTRAP_FAILED",
          false,
          "Retained launch did not complete authenticated startup.",
        );
      console.log(
        JSON.stringify({
          started: true,
          origin: grant.origin,
          hostBuildId: args[1],
        }),
      );
      return;
    } catch (error) {
      if (error instanceof CliFailure) throw error;
      const code =
        error instanceof Error && "code" in error
          ? String(error.code)
          : "HOST_RETAINED_LAUNCH_FAILED";
      fail(
        "readiness",
        code,
        false,
        "Retained launch was refused or failed at the reported boundary; no running host was replaced.",
      );
    }
  }
  if (
    args.length === 2 &&
    args[0] === "recover-host" &&
    args[1] === "--previous"
  ) {
    try {
      await control(root, { type: "health" });
      fail(
        "control",
        "HOST_PRESENT",
        false,
        "Recovery never replaces a running host. Use the approved restart owner.",
      );
    } catch (error) {
      if (!(
        error instanceof CliFailure &&
        error.detail.code === "CONTROL_UNAVAILABLE"
      ))
        throw error;
    }
    try {
      if (
        !(await launchRetained(
          root,
          () => control(root, { type: "health" }),
          true,
        ))
      )
        fail(
          "control",
          "PREVIOUS_HOST_UNAVAILABLE",
          false,
          "No retained previous host is recorded.",
        );
      const grant = await control(root, { type: "bootstrap" });
      const response = await fetch(grant.origin + "/v1/bootstrap", {
        method: "POST",
        headers: { Origin: grant.origin, "Content-Type": "application/json" },
        body: JSON.stringify({ nonce: grant.nonce }),
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok)
        fail(
          "readiness",
          "HOST_REBOOTSTRAP_FAILED",
          false,
          "The previous host did not complete authenticated recovery.",
        );
      console.log(JSON.stringify({ recovered: true, origin: grant.origin }));
      return;
    } catch (error) {
      if (error instanceof CliFailure) throw error;
      const code =
        error instanceof Error && "code" in error
          ? String(error.code)
          : "HOST_RECOVERY_FAILED";
      fail(
        "readiness",
        code,
        false,
        "Inspect the recovery category before retrying; no process was force-stopped.",
      );
    }
  }
  let request: Record<string, unknown>;
  if (args.length === 1 && ["status", "check"].includes(args[0]))
    request = { type: "updates-status" };
  else if (args.length === 2 && args[0] === "associate" && isAbsolute(args[1]))
    request = { type: "associate-updates", path: args[1] };
  else if (args.length === 2 && args[0] === "cancel")
    request = {
      type: "updates-restart",
      action: "cancel",
      operationId: args[1],
    };
  else if (
    args[0] === "restart" &&
    /^[a-f0-9]{64}$/.test(args[1] ?? "") &&
    /^\d+$/.test(args[2] ?? "") &&
    args.includes("--confirm") &&
    args.slice(3).every((flag) => ["--confirm", "--when-idle"].includes(flag))
  )
    request = {
      type: "updates-restart",
      action: "approve",
      targetBuildId: args[1],
      generation: Number(args[2]),
      confirm: true,
      mode: args.includes("--when-idle") ? "when-idle" : "now",
    };
  else
    fail(
      "control",
      "UPDATES_COMMAND_UNSUPPORTED",
      false,
      "Use updates status/check/import/diagnostics, associate <absolute-checkout>, start-retained <host-id> <ui-id> --confirm, recover-host --previous, restart <exact-build-id> <generation> --confirm [--when-idle], or cancel <operation-id>.",
    );
  const result = await control(root, request!);
  if (result.error)
    fail(
      "control",
      String(result.error),
      false,
      "The update action was refused; no active work was stopped. Inspect updates status.",
    );
  console.log(JSON.stringify(result));
  return;
}
