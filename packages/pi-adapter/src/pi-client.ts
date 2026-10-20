import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { randomUUID } from "node:crypto";
import { JsonlDecoder } from "./jsonl-decoder.js";
import { Translator } from "./translator.js";
import {
  isSessionTooSmallForCompaction,
  rpcResponseTimeout,
} from "./compaction.js";
import type {
  RuntimeStartupDiagnostic,
  RuntimeStartupStage,
  RuntimeStartupTrigger,
} from "./startup-types.js";
import { SuriError, publicModel, type Data } from "../../protocol/src/index.js";

export class PiClient {
  readonly child: ChildProcessByStdio<Writable, Readable, Readable>;
  readonly translator: Translator;
  readonly exited: Promise<void>;
  readonly startupAttemptId: string;
  private closing = false;
  private startupStage: RuntimeStartupStage = "spawn";
  private readinessReached = false;
  private startupComplete = false;
  private preserveTerminalState = false;
  private terminalError?: SuriError;
  private startupTrigger: RuntimeStartupTrigger = "other";
  private startupDiagnostic?: (value: RuntimeStartupDiagnostic) => void;
  private startupStartedAt = Date.now();
  private startupDiagnosticSent = false;
  get hasPendingRequests() {
    return this.pending.size > 0;
  }
  private pending = new Map<
    string,
    {
      type: string;
      resolve: (d: Data) => void;
      reject: (e: Error) => void;
      timer: NodeJS.Timeout;
    }
  >();
  constructor(
    options: {
      executable: string;
      cwd: string;
      sessionDir: string;
      sessionFile?: string;
      agentDir?: string;
      extraArgs?: string[];
      startup?: {
        attemptId?: string;
        trigger: RuntimeStartupTrigger;
        diagnostic?: (value: RuntimeStartupDiagnostic) => void;
      };
      /** Host-owned authenticated broker. Descriptor privacy is defense in depth only. */
      privateControl?: {
        handshake: string;
        handle: (rawFrame: string) => Promise<string | undefined>;
        close?: () => void;
      };
    },
    emit: (type: string, p: Data) => void,
  ) {
    this.translator = new Translator(emit);
    this.startupAttemptId = options.startup?.attemptId ?? randomUUID();
    this.startupTrigger = options.startup?.trigger ?? "other";
    this.startupDiagnostic = options.startup?.diagnostic;
    this.startupStartedAt = Date.now();
    const startedAt = this.startupStartedAt;
    let stderr = "";
    const elapsed = (): RuntimeStartupDiagnostic["elapsed"] => {
      const duration = Date.now() - startedAt;
      return duration < 1000
        ? "under-1s"
        : duration < 5000
          ? "1-5s"
          : duration < 15000
            ? "5-15s"
            : "over-15s";
    };
    const category = (): RuntimeStartupDiagnostic["category"] => {
      if (/\bENOTTY\b/i.test(stderr)) return "enotty";
      if (/\bEEXIST\b/i.test(stderr)) return "descriptor-in-use";
      if (/extension.{0,80}(load|factory|failed|error)/i.test(stderr))
        return "extension-load";
      if (this.startupStage === "rpc-readiness" && /MALFORMED_RPC/.test(stderr))
        return "malformed-rpc";
      return "unknown";
    };
    const report = (extra: Partial<RuntimeStartupDiagnostic> = {}) => {
      if (this.startupDiagnosticSent || this.startupComplete || this.closing)
        return;
      this.startupDiagnosticSent = true;
      const value: RuntimeStartupDiagnostic = {
        attemptId: this.startupAttemptId,
        trigger: options.startup?.trigger ?? "other",
        stage: this.startupStage,
        category: category(),
        readinessReached: this.readinessReached,
        elapsed: elapsed(),
        ...extra,
      };
      options.startup?.diagnostic?.(value);
      this.terminalError = new SuriError(
        "RUNTIME_UNAVAILABLE",
        `Pi startup failed (${value.category}, ${value.stage}; attempt ${value.attemptId}).`,
      );
    };
    const args = [
      "--mode",
      "rpc",
      "--session-dir",
      options.sessionDir,
      ...(options.sessionFile ? ["--session", options.sessionFile] : []),
      ...(options.extraArgs ?? []),
    ];
    this.child = spawn(options.executable, args, {
      cwd: options.cwd,
      env: {
        ...process.env,
        ...(options.agentDir ? { PI_CODING_AGENT_DIR: options.agentDir } : {}),
      },
      stdio: options.privateControl
        ? ["pipe", "pipe", "pipe", "pipe"]
        : ["pipe", "pipe", "pipe"],
      detached: true,
    });
    if (!this.child.stdin || !this.child.stdout || !this.child.stderr)
      throw new Error("RUNTIME_PIPE_UNAVAILABLE");
    let closePrivateControl: () => void = () => undefined;
    if (options.privateControl) {
      const control = this.child.stdio[3];
      if (!control || typeof control === "number" || !("on" in control))
        throw new Error("PRIVATE_CONTROL_UNAVAILABLE");
      let buffer = "";
      let closed = false;
      const close = () => {
        if (closed) return;
        closed = true;
        options.privateControl?.close?.();
      };
      closePrivateControl = close;
      const writeControl = (value: string) => {
        if (closed || !("write" in control)) return;
        try {
          control.write(value, (error?: Error | null) => {
            if (error) close();
          });
        } catch {
          close();
        }
      };
      control.on("error", close);
      control.once("close", close);
      this.child.once("exit", close);
      writeControl(`${options.privateControl.handshake}\n`);
      control.on("data", (chunk: Buffer) => {
        buffer += chunk.toString("utf8");
        if (Buffer.byteLength(buffer) > 32 * 1024) {
          buffer = "";
          return;
        }
        while (buffer.includes("\n")) {
          const index = buffer.indexOf("\n");
          const line = buffer.slice(0, index);
          buffer = buffer.slice(index + 1);
          // Best effort: a failed private-control request gets no reply; the stream keeps running.
          void options
            .privateControl!.handle(line)
            .then((response) => {
              if (response) writeControl(`${response}\n`);
            })
            .catch(() => undefined);
        }
      });
    }
    const decoder = new JsonlDecoder(
      (r) => {
        if (r.type === "response") {
          const p = this.pending.get(r.id);
          if (!p) return;
          if (r.command !== p.type) {
            p.reject(
              new SuriError(
                "UPSTREAM_REJECTED",
                "Mismatched runtime response.",
              ),
            );
          } else if (!r.success) {
            const detail =
              typeof r.error === "string"
                ? r.error.replace(/\s+/g, " ").trim().slice(0, 300)
                : "";
            if (p.type === "compact" && isSessionTooSmallForCompaction(detail))
              p.resolve({ compacted: false, reason: "session-too-small" });
            else
              p.reject(
                new SuriError(
                  "UPSTREAM_REJECTED",
                  p.type === "compact"
                    ? "Pi could not compact this session. Retry after more history is available, or continue without compacting."
                    : "Pi rejected the operation.",
                ),
              );
          } else {
            p.resolve(r.data ?? {});
            if (p.type === "get_state" && !this.readinessReached)
              this.readinessReached = true;
          }
          clearTimeout(p.timer);
          this.pending.delete(r.id);
        } else this.translator.record(r);
      },
      (code) => this.translator.fault(code),
      undefined,
      true,
    );
    // Once stdout is finalized (end of stream, or the exit grace period
    // expired) later data is ignored and the decoder is closed exactly once.
    let stdoutFinal = false;
    const finalizeStdout = () => {
      if (stdoutFinal) return;
      stdoutFinal = true;
      decoder.end();
    };
    this.child.stdout.on("data", (b) => {
      if (!stdoutFinal) decoder.feed(b);
    });
    this.child.stdout.on("end", finalizeStdout);
    this.child.stderr.on("data", (chunk: Buffer) => {
      if (Buffer.byteLength(stderr) >= 8192) return;
      stderr += chunk
        .toString("utf8")
        .slice(0, 8192 - Buffer.byteLength(stderr));
    });
    this.exited = new Promise<void>((resolve) => {
      let settled = false;
      let spawned = false;
      const exited = (
        error?: NodeJS.ErrnoException,
        code?: number | null,
        signal?: NodeJS.Signals | null,
      ) => {
        if (settled) return;
        settled = true;
        closePrivateControl();
        // Records still held behind the response ordering barrier are
        // delivered before the exit is reported to the pending requests.
        if (decoder.idle) finish(error, code, signal);
        else void decoder.drained().then(() => finish(error, code, signal));
      };
      const finish = (
        error?: NodeJS.ErrnoException,
        code?: number | null,
        signal?: NodeJS.Signals | null,
      ) => {
        if (!this.closing && !this.startupComplete)
          report({
            ...(typeof code === "number" ? { exitCode: code } : {}),
            ...(signal ? { signal } : {}),
            ...(error?.code
              ? { spawnCode: error.code, category: "spawn" }
              : {}),
          });
        for (const p of this.pending.values()) {
          clearTimeout(p.timer);
          p.reject(
            this.terminalError ??
              new SuriError("INTERRUPTED", "The runtime exited."),
          );
        }
        this.pending.clear();
        if (!this.preserveTerminalState)
          emit(
            "session.state",
            this.closing
              ? { phase: "closed" }
              : { phase: "interrupted", outcome: "interrupted" },
          );
        resolve();
      };
      this.child.once("spawn", () => {
        spawned = true;
      });
      this.child.on("error", (error) => {
        // A pre-spawn error (for example ENOENT/EACCES) is terminal and has no
        // following exit event. An error after spawn is not proof of process exit.
        if (!spawned) exited(error);
      });
      this.child.once("exit", (code, signal) => {
        // Output written before the exit may still be unread: report the exit
        // after stdout ends (or after a grace period if a descendant keeps the
        // pipe open), so the decoder has seen every record first.
        if (this.child.stdout.readableEnded)
          return exited(undefined, code, signal);
        const done = () => {
          clearTimeout(grace);
          // After the grace period nothing more is read: finalize the decoder
          // (parsing an unterminated tail) before reporting the exit.
          finalizeStdout();
          exited(undefined, code, signal);
        };
        const grace = setTimeout(done, 1000);
        this.child.stdout.once("end", done);
        this.child.stdout.once("close", done);
      });
      this.child.once("close", (code, signal) => {
        finalizeStdout();
        exited(undefined, code, signal);
      });
    });
  }
  request(
    type: string,
    data: Data = {},
    timeout = rpcResponseTimeout(type),
  ): Promise<Data> {
    if (this.terminalError) return Promise.reject(this.terminalError);
    if (!this.startupComplete && type === "get_state" && !this.readinessReached)
      this.startupStage = "rpc-readiness";
    else if (
      !this.startupComplete &&
      ["set_model", "set_thinking_level"].includes(type)
    )
      this.startupStage = "model-apply";
    const banned = [
      "set_auto_compaction",
      "set_auto_retry",
      "set_steering_mode",
      "set_follow_up_mode",
    ];
    if (banned.includes(type))
      return Promise.reject(
        new SuriError("VALIDATION", "Global settings writes are excluded."),
      );
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        if (
          !this.startupComplete &&
          !this.startupDiagnosticSent &&
          ["get_state", "set_model", "set_thinking_level"].includes(type)
        ) {
          this.startupDiagnosticSent = true;
          const diagnostic: RuntimeStartupDiagnostic = {
            attemptId: this.startupAttemptId,
            trigger: this.startupTrigger,
            stage: this.startupStage,
            category: "timeout",
            readinessReached: this.readinessReached,
            elapsed:
              Date.now() - this.startupStartedAt < 1000
                ? "under-1s"
                : Date.now() - this.startupStartedAt < 5000
                  ? "1-5s"
                  : Date.now() - this.startupStartedAt < 15000
                    ? "5-15s"
                    : "over-15s",
          };
          this.startupDiagnostic?.(diagnostic);
          this.terminalError = new SuriError(
            "RUNTIME_UNAVAILABLE",
            `Pi startup failed (${diagnostic.category}, ${diagnostic.stage}; attempt ${diagnostic.attemptId}).`,
          );
        }
        reject(
          new SuriError(
            "INDETERMINATE",
            "Pi response timed out; the operation will not be retried.",
          ),
        );
      }, timeout);
      this.pending.set(id, { type, resolve, reject, timer });
      this.child.stdin.write(
        JSON.stringify({ id, type, ...data }) + "\n",
        (e) => {
          if (e) {
            clearTimeout(timer);
            this.pending.delete(id);
            reject(new SuriError("INTERRUPTED", "Runtime input closed."));
          }
        },
      );
    });
  }
  respond(id: string, answer: Data) {
    this.child.stdin.write(
      JSON.stringify({ type: "extension_ui_response", id, ...answer }) + "\n",
    );
  }
  async stop() {
    await this.request("clear_queue");
    this.translator.cancelling();
    await this.request("abort");
  }
  async models() {
    const d = await this.request("get_available_models");
    return { models: (d.models ?? []).map(publicModel) };
  }
  completeStartup() {
    this.startupComplete = true;
  }
  close(preserveTerminalState = false) {
    this.closing = true;
    this.preserveTerminalState ||= preserveTerminalState;
    this.child.stdin.end();
  }
  async retireFailedStartup(grace = 250, terminate = 2000) {
    this.close(true);
    const wait = async (timeout: number) => {
      let timer: NodeJS.Timeout | undefined;
      try {
        return await Promise.race([
          this.exited.then(() => true),
          new Promise<false>((resolve) => {
            timer = setTimeout(() => resolve(false), timeout);
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    };
    if (await wait(grace)) return;
    this.forceStop();
    if (await wait(terminate)) return;
    if (this.child.pid && this.child.exitCode === null) {
      try {
        process.kill(-this.child.pid, "SIGKILL");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    }
    await this.exited;
  }
  async closeAndWait(timeout = 5000) {
    this.close();
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        this.exited,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new SuriError(
                  "RUNTIME_EXIT_TIMEOUT",
                  "An owned runtime did not exit during shutdown.",
                  true,
                ),
              ),
            timeout,
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  forceStop() {
    if (this.child.pid && this.child.exitCode === null)
      process.kill(-this.child.pid, "SIGTERM");
  }
}
