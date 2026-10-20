import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PiClient, probe } from "../../../packages/pi-adapter/src/index.js";
import { SuriError, type Data } from "../../../packages/protocol/src/index.js";
import { closeAndRetire } from "./runtime-exit.js";
import { validateRuntimeAcceptanceEvidence } from "./runtime-evidence.js";
import type { Storage } from "./storage.js";

export type RuntimeValidationProfile = {
  provider: string;
  model: string;
  agentDir: string;
};

type RuntimeAcceptanceEvidence = {
  schema: "suri.runtime-acceptance.v1";
  scope: "real-pi";
  producer: "suri-host-runtime-validation/v1";
  simulated: false;
  passed: true;
  version: string;
  identity: string;
  executableSha256: string;
  adapterIdentity: "suri-pi-adapter/v1";
  evidenceId: string;
  validatedAt: string;
  cases: Record<string, true>;
};

type AcceptanceRunner = (
  executable: string,
  version: string,
  profile: RuntimeValidationProfile,
) => Promise<RuntimeAcceptanceEvidence>;

/**
 * Sessions never pass an agent directory to Pi; they inherit the host
 * environment. Validation must therefore use that same profile, or a profile
 * that sessions do not use could promote a runtime.
 *
 * Pi expands a leading `~` or `~/` and converts `file://` URLs in
 * PI_CODING_AGENT_DIR (checked against Pi 0.85.1 sources). A relative value would be
 * resolved against each process's cwd (the host's here, the workspace's for
 * sessions), so it is rejected rather than guessed.
 */
function sessionAgentDir(env: NodeJS.ProcessEnv) {
  const raw = env.PI_CODING_AGENT_DIR;
  if (!raw) return join(homedir(), ".pi", "agent");
  if (raw === "~") return homedir();
  if (raw.startsWith("~/")) return join(homedir(), raw.slice(2));
  if (raw.startsWith("file://")) return fileURLToPath(raw);
  return raw;
}

/** Real path when the directory exists; otherwise the normalized absolute path. */
function canonicalDir(path: string) {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

export function assertSessionProfile(
  profile: RuntimeValidationProfile,
  env: NodeJS.ProcessEnv = process.env,
) {
  const sessions = sessionAgentDir(env);
  if (!isAbsolute(sessions) || !isAbsolute(profile.agentDir))
    throw new SuriError(
      "RUNTIME_VALIDATION_PROFILE_RELATIVE",
      "The Pi agent directory must be an absolute path, both in PI_CODING_AGENT_DIR for the host and in --agent-dir.",
    );
  if (canonicalDir(profile.agentDir) !== canonicalDir(sessions))
    throw new SuriError(
      "RUNTIME_VALIDATION_PROFILE_MISMATCH",
      "Validation must use the Pi agent directory that sessions use. Start the host with PI_CODING_AGENT_DIR set to it, or pass the default directory.",
    );
}

function validationFailure(stage: string): never {
  throw new SuriError(
    `RUNTIME_VALIDATION_${stage.toUpperCase()}_FAILED`,
    `Real Pi validation failed during ${stage}. The runtime was not promoted.`,
  );
}

async function waitFor(
  events: Array<{ type: string } & Data>,
  from: number,
  predicate: (event: { type: string } & Data) => boolean,
  timeout: number,
  stage: string,
) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const match = events.slice(from).find(predicate);
    if (match) return match;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  validationFailure(stage);
}

async function runRealRuntimeAcceptance(
  executable: string,
  version: string,
  profile: RuntimeValidationProfile,
): Promise<RuntimeAcceptanceEvidence> {
  assertSessionProfile(profile);
  const identity = await probe(executable, version);
  const root = await mkdtemp(join(tmpdir(), "suri-runtime-validation-"));
  const workspace = join(root, "workspace");
  const sessionDir = join(root, "sessions");
  const events: Array<{ type: string } & Data> = [];
  const emit = (type: string, payload: Data) =>
    events.push({ type, ...payload });
  let client: PiClient | undefined;
  let resumed: PiClient | undefined;
  try {
    await mkdir(workspace, { recursive: true, mode: 0o700 });
    await mkdir(sessionDir, { recursive: true, mode: 0o700 });
    await writeFile(join(workspace, "hello.txt"), "hello\n", { mode: 0o600 });
    client = new PiClient(
      {
        executable: identity.executable,
        cwd: workspace,
        sessionDir,
        agentDir: profile.agentDir,
        extraArgs: ["--no-extensions", "--no-skills", "--no-prompt-templates"],
      },
      emit,
    );
    let state: Data;
    try {
      state = await client.request("get_state");
    } catch {
      validationFailure("spawn");
    }
    let available: Awaited<ReturnType<PiClient["models"]>>;
    try {
      available = await client.models();
    } catch {
      validationFailure("model");
    }
    if (
      !available.models.some(
        (model: Data) =>
          model.provider === profile.provider && model.id === profile.model,
      )
    )
      validationFailure("model");
    try {
      await client.request("set_model", {
        provider: profile.provider,
        modelId: profile.model,
      });
    } catch {
      validationFailure("model");
    }

    const firstRun = events.length;
    await client.request("prompt", {
      message:
        "Use the read tool to read only hello.txt. Then reply exactly: suri-runtime-validation hello.",
    });
    const completed = await waitFor(
      events,
      firstRun,
      (event) => event.type === "run.state" && event.outcome !== undefined,
      90_000,
      "tool-call",
    );
    if (completed.outcome !== "completed") validationFailure("tool-call");
    if (
      !events
        .slice(firstRun)
        .some(
          (event) =>
            event.type === "tool.state" &&
            event.name === "read" &&
            event.phase === "completed",
        )
    )
      validationFailure("tool-call");
    if (
      !events
        .slice(firstRun)
        .some(
          (event) =>
            (event.type === "message.delta" &&
              typeof event.text === "string" &&
              event.text.length > 0) ||
            (event.type === "message.upsert" && event.final === false),
        )
    )
      validationFailure("stream");

    const persisted = await client.request("get_state");
    const messages = await client.request("get_messages");
    const sessionFile = String(
      persisted.sessionFile ?? state.sessionFile ?? "",
    );
    if (!sessionFile || !(await readFile(sessionFile)).length)
      validationFailure("persistence");
    await closeAndRetire(client);
    client = undefined;

    const resumedEvents: Array<{ type: string } & Data> = [];
    resumed = new PiClient(
      {
        executable: identity.executable,
        cwd: workspace,
        sessionDir,
        sessionFile,
        agentDir: profile.agentDir,
        extraArgs: ["--no-extensions", "--no-skills", "--no-prompt-templates"],
      },
      (type, payload) => resumedEvents.push({ type, ...payload }),
    );
    let restored: Data;
    let history: Data;
    try {
      restored = await resumed.request("get_state");
      history = await resumed.request("get_messages");
    } catch {
      validationFailure("reconnect");
    }
    if (
      restored.sessionId !== persisted.sessionId ||
      !Array.isArray(history.messages) ||
      !Array.isArray(messages.messages) ||
      history.messages.length !== messages.messages.length
    )
      validationFailure("resume");

    const cancelRun = resumedEvents.length;
    await resumed.request("prompt", {
      message:
        "Use the bash tool to run exactly: sleep 20; printf suri-runtime-cancel. Do not use any other tool.",
    });
    await waitFor(
      resumedEvents,
      cancelRun,
      (event) =>
        event.type === "tool.state" &&
        event.name === "bash" &&
        event.phase === "running",
      30_000,
      "cancel",
    );
    await resumed.stop();
    const cancelled = await waitFor(
      resumedEvents,
      cancelRun,
      (event) => event.type === "run.state" && event.outcome !== undefined,
      20_000,
      "cancel",
    );
    if (cancelled.outcome !== "cancelled") validationFailure("cancel");

    return {
      schema: "suri.runtime-acceptance.v1",
      scope: "real-pi",
      producer: "suri-host-runtime-validation/v1",
      simulated: false,
      passed: true,
      version: identity.version,
      identity: identity.identity,
      executableSha256: identity.executableSha256,
      adapterIdentity: identity.adapterIdentity,
      evidenceId: randomUUID(),
      validatedAt: new Date().toISOString(),
      cases: {
        spawn: true,
        stream: true,
        "tool-call": true,
        cancel: true,
        reconnect: true,
        resume: true,
        persistence: true,
      },
    };
  } finally {
    const retired = await Promise.allSettled(
      [client, resumed].map((item) => item && closeAndRetire(item)),
    );
    const stuck = retired.find((item) => item.status === "rejected");
    // A child that survived SIGKILL may still use files under root; keep them.
    if (!stuck) await rm(root, { recursive: true, force: true });
    else throw (stuck as PromiseRejectedResult).reason;
  }
}

export class RuntimeValidator {
  constructor(
    private readonly runAcceptance: AcceptanceRunner = runRealRuntimeAcceptance,
  ) {}

  async validateAndPromote(
    store: Storage,
    runtimeId: string,
    profile: RuntimeValidationProfile,
  ) {
    const runtime = store.get("runtime", runtimeId);
    const evidence = await this.runAcceptance(
      String(runtime.executable),
      String(runtime.version),
      profile,
    );
    const identity = await probe(
      String(runtime.executable),
      String(runtime.version),
    );
    const accepted = validateRuntimeAcceptanceEvidence(
      evidence,
      identity,
      true,
    );
    const evidenceDir = join(store.root, "runtime-evidence");
    await mkdir(evidenceDir, { recursive: true, mode: 0o700 });
    const target = join(evidenceDir, `${accepted.evidenceId}.json`);
    const temporary = `${target}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(evidence, null, 2) + "\n", {
      mode: 0o600,
      flag: "wx",
    });
    await rename(temporary, target);
    const promoted = store.put("runtime", {
      ...runtime,
      ...identity,
      status: "verified",
      evidenceId: accepted.evidenceId,
      validatedAt: accepted.validatedAt,
      revision: Number(runtime.revision ?? 0) + 1,
    });
    return promoted;
  }
}
