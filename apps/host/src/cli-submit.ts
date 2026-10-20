import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { root, CliFailure, fail } from "./cli-env.js";
import {
  assertCompatibleHealth,
  assertShutdownReceipt,
  type ShutdownReceipt,
  control,
  openWorkingBrowser,
} from "./cli-control.js";
import { ensure } from "./cli-ensure.js";

type LifecycleHealth = {
  uiContract?: unknown;
  activeWork: number;
  instanceId: string;
};
type CommandPayload = { expectedInstanceId?: string; [field: string]: unknown };

export async function runAction(action: string, args: string[]) {
  let lifecycleHealth!: LifecycleHealth;
  if (action === "shutdown" || action === "restart") {
    try {
      lifecycleHealth = await control(root, { type: "health" });
      assertCompatibleHealth(lifecycleHealth);
      if (action === "restart" && lifecycleHealth.uiContract === 2)
        fail(
          "control",
          "EXACT_TARGET_APPROVAL_REQUIRED",
          false,
          "Use Updates or updates restart <build-id> <generation> --confirm; the retained lifecycle owner preserves this host until admission.",
        );
    } catch (error) {
      if (
        action === "shutdown" &&
        error instanceof CliFailure &&
        error.detail.code === "CONTROL_UNAVAILABLE"
      ) {
        console.log(JSON.stringify({ present: false, stopped: false }));
        return;
      }
      if (
        action === "restart" &&
        error instanceof CliFailure &&
        error.detail.code === "CONTROL_UNAVAILABLE"
      )
        fail(
          "control",
          "HOST_ABSENT",
          true,
          "Start the host with suri open instead of reporting a restart.",
        );
      throw error;
    }
  }
  const actions = new Set([
    "open",
    "bootstrap",
    "bootstrap-running",
    "associate-ui",
    "grant-directory",
    "grant-files",
    "add-project",
    "import-session",
    "catalog",
    "register-runtime",
    "validate-runtime",
    "ui-builds",
    "activate-ui",
    "shutdown",
    "restart",
  ]);
  if (!actions.has(action))
    fail(
      "control",
      "UNKNOWN_ACTION",
      false,
      "Run suri doctor, status, open, restart, or shutdown.",
    );
  const positional = args.find((arg) => !arg.startsWith("--"));
  const needsPositional: Record<string, string> = {
    "add-project": "Usage: suri add-project <directory>",
    "import-session":
      "Usage: suri import-session <file> [workspaceId] [runtimeId]",
    "register-runtime": "Usage: suri register-runtime <executable> [version]",
    "validate-runtime":
      "Usage: suri validate-runtime <runtimeId> --provider=... --model=... --agent-dir=... --confirm-provider-spend",
  };
  const firstIsPath = args[0] !== undefined && !args[0].startsWith("--");
  if (
    action in needsPositional &&
    (action === "validate-runtime" ? !positional : !firstIsPath)
  )
    fail("control", "CLI_USAGE", false, needsPositional[action]);
  if (
    action !== "shutdown" &&
    action !== "restart" &&
    action !== "bootstrap-running"
  )
    await ensure();
  if (action === "associate-ui") {
    await control(root, { type: "associate-ui", path: resolve(args[0]) });
    console.log("Trusted Suri UI checkout associated.");
    return;
  }
  if (action === "grant-directory") {
    const grant = await control(root, {
      type: "grant",
      kind: "directory",
      path: resolve(args[0]),
    });
    process.stdout.write(grant.grantId + "\n");
    return;
  }
  if (action === "grant-files") {
    const granted = [];
    for (const path of args) {
      const item = await control(root, {
        type: "grant",
        kind: "file",
        path: resolve(path),
      });
      granted.push({ grantId: item.grantId });
    }
    process.stdout.write(JSON.stringify(granted));
    return;
  }
  let runtimeValidationGrantId: string | undefined;
  if (action === "validate-runtime") {
    const provider = args
      .find((arg) => arg.startsWith("--provider="))
      ?.slice(11);
    const model = args.find((arg) => arg.startsWith("--model="))?.slice(8);
    const agentDir = args
      .find((arg) => arg.startsWith("--agent-dir="))
      ?.slice(12);
    if (
      !args.includes("--confirm-provider-spend") ||
      !provider ||
      !model ||
      !agentDir
    )
      fail(
        "control",
        "RUNTIME_VALIDATION_UNAUTHORIZED",
        false,
        "Provide provider, model, agent directory, and --confirm-provider-spend after explicit authorization.",
      );
    const granted = await control(root, {
      type: "runtime-validation-grant",
      provider,
      model,
      agentDir: resolve(agentDir),
      confirmProviderSpend: true,
    });
    if (typeof granted.grantId !== "string")
      fail(
        "control",
        "RUNTIME_VALIDATION_UNAUTHORIZED",
        false,
        "The running host did not grant real Pi validation.",
      );
    runtimeValidationGrantId = granted.grantId;
  }
  const b = await control(root, {
    type: "bootstrap",
    clientId:
      action === "bootstrap" || action === "bootstrap-running"
        ? args[0]
        : undefined,
  });
  if (action === "bootstrap" || action === "bootstrap-running") {
    process.stdout.write(JSON.stringify(b));
    return;
  }
  if (action === "open") {
    if (args.includes("--no-open")) {
      console.log(JSON.stringify({ started: true, origin: b.origin }));
      return;
    }
    const url = `${b.origin}/#nonce=${b.nonce}`;
    await openWorkingBrowser(root, url, args.includes("--new-tab"));
    return;
  }
  const response = await fetch(b.origin + "/v1/bootstrap", {
    method: "POST",
    headers: { Origin: b.origin, "Content-Type": "application/json" },
    body: JSON.stringify({ nonce: b.nonce }),
  });
  const cookie = response.headers.get("set-cookie")!.split(";")[0];
  const auth = (await response.json()) as { csrf: string };
  let type = "",
    payload = {} as CommandPayload;
  if (action === "add-project") {
    const g = await control(root, {
      type: "grant",
      kind: "directory",
      path: resolve(args[0]),
    });
    type = "project.add";
    payload = { directoryGrantId: g.grantId };
  } else if (action === "import-session") {
    const grant = await control(root, {
      type: "grant",
      kind: "file",
      path: resolve(args[0]),
    });
    type = "session.import";
    payload = {
      fileGrantId: grant.grantId,
      workspaceId: args[1],
      runtimeId: args[2],
    };
  } else if (action === "catalog") {
    type = "catalog.get";
  } else if (action === "register-runtime") {
    const g = await control(root, {
      type: "grant",
      kind: "executable",
      path: resolve(args[0]),
    });
    type = "runtime.register";
    payload = { executableGrantId: g.grantId, expectedVersion: args[1] };
  } else if (action === "validate-runtime") {
    type = "runtime.validate";
    payload = {
      runtimeId: positional,
      validationGrantId: runtimeValidationGrantId,
    };
  } else if (action === "ui-builds") {
    type = "ui.builds";
  } else if (action === "activate-ui") {
    type = "ui.activate";
    payload = { buildId: args[0] };
  } else if (action === "shutdown" || action === "restart") {
    const health = lifecycleHealth;
    if (health.activeWork > 0)
      fail(
        "control",
        "HOST_BUSY",
        true,
        "Finish or stop active session work before restarting.",
      );
    payload = { expectedInstanceId: health.instanceId };
    type = "host.shutdown";
  } else
    fail(
      "control",
      "UNKNOWN_ACTION",
      false,
      "Use open, doctor, status, add-project, register-runtime, or shutdown.",
    );
  const command = {
    v: 1,
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    type,
    payload,
  };
  const submit = async () => {
    const response = await fetch(b.origin + "/v1/commands", {
      method: "POST",
      headers: {
        Origin: b.origin,
        Cookie: cookie,
        "X-Suri-Csrf": auth.csrf,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(command),
    });
    return response.json() as Promise<ShutdownReceipt>;
  };
  let result = await submit();
  if (action === "validate-runtime" && result.status === "accepted") {
    const deadline = Date.now() + 4 * 60_000;
    while (result.status === "accepted" && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      result = await submit();
    }
    if (result.status === "accepted")
      fail(
        "control",
        "RUNTIME_VALIDATION_TIMEOUT",
        true,
        "Keep the host running and inspect the eventual bounded command receipt before retrying.",
      );
  }
  if (action !== "shutdown" && action !== "restart") {
    console.log(JSON.stringify(result));
    if (action === "validate-runtime" && result.status !== "completed")
      process.exitCode = 1;
    return;
  }
  assertShutdownReceipt(result, payload.expectedInstanceId!);
  let oldStopped = false;
  let shutdownStage = "unknown";
  for (let i = 0; i < 50; i++) {
    try {
      const health = await control(root, { type: "health" });
      shutdownStage =
        typeof health?.shutdownStage === "string" &&
        ["http", "drain", "children", "storage", "lock", "control"].includes(
          health.shutdownStage,
        )
          ? health.shutdownStage
          : "unknown";
      if (health?.instanceId !== payload.expectedInstanceId)
        fail(
          "control",
          "HOST_IDENTITY_CHANGED_DURING_SHUTDOWN",
          false,
          "Leave the unexpected host running and inspect profile ownership.",
        );
      await new Promise((resolve) => setTimeout(resolve, 100));
    } catch (error) {
      if (
        error instanceof CliFailure &&
        ["CONTROL_UNAVAILABLE", "HOST_STOPPING"].includes(error.detail.code)
      ) {
        if (error.detail.code === "CONTROL_UNAVAILABLE") {
          oldStopped = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
        continue;
      }
      throw error;
    }
  }
  if (!oldStopped)
    fail(
      "readiness",
      `HOST_SHUTDOWN_${shutdownStage.toUpperCase()}_TIMEOUT`,
      true,
      "Keep the old host profile intact and inspect the reported shutdown stage.",
    );
  if (action === "shutdown") {
    console.log(
      JSON.stringify({
        ...result,
        result: { ...result.result, stopped: true },
      }),
    );
    return;
  }
  const previousPort = process.env.SURI_PORT;
  process.env.SURI_PORT = new URL(b.origin).port;
  try {
    await ensure();
  } finally {
    if (previousPort === undefined) delete process.env.SURI_PORT;
    else process.env.SURI_PORT = previousPort;
  }
  const health = await control(root, { type: "health" });
  assertCompatibleHealth(health);
  if (health.instanceId === payload.expectedInstanceId)
    fail(
      "readiness",
      "HOST_EPOCH_UNCHANGED",
      false,
      "Do not report restart success until a new host instance is proven.",
    );
  const fresh = await control(root, { type: "bootstrap" });
  if (fresh.origin !== b.origin)
    fail(
      "readiness",
      "HOST_ADDRESS_CHANGED",
      false,
      "Keep the restarted host on the prior loopback address.",
    );
  if (args.includes("--no-open")) {
    console.log(JSON.stringify({ restarted: true, origin: fresh.origin }));
    return;
  }
  const url = `${fresh.origin}/#nonce=${fresh.nonce}`;
  await openWorkingBrowser(root, url, args.includes("--new-tab"));
}
