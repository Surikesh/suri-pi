import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { ReviewQueueRuntimeError } from "./review-queue-error.js";
import { authorityKey, digest } from "./review-queue-digest.js";
import {
  canonicalAuthority,
  contains,
  runBounded,
  safeRelative,
} from "./review-queue-io.js";
import {
  assertAdmittedExecutable,
  seatbeltProfile,
} from "./review-queue-sandbox.js";
import {
  secureDirectory,
  snapshotCandidate,
} from "./review-queue-candidate.js";
import type {
  QueueAuthority,
  QueueReceipt,
  Session,
} from "./review-queue-types.js";

export type { QueueAuthority, QueueReceipt } from "./review-queue-types.js";
export { ReviewQueueRuntimeError } from "./review-queue-error.js";
export { candidateDigest } from "./review-queue-candidate.js";

/** Provider-free owner-side enforcement used by the fenced review queue. */
export class ReviewQueueRuntime {
  private receipts = new Map<string, QueueReceipt>();
  private sessions = new Map<string, Session>();
  private epochs = new Map<string, number>();
  private readonly snapshotRoot: string;
  private readonly helper: string;
  private readonly storageRoot: string;

  constructor(
    snapshotRoot = join(tmpdir(), "suri-review-queue-snapshots"),
    helper = resolve("dist/native/suri-helper"),
    storageRoot = dirname(snapshotRoot),
  ) {
    this.snapshotRoot = resolve(snapshotRoot);
    this.helper = resolve(helper);
    this.storageRoot = resolve(storageRoot);
  }

  async available() {
    try {
      await access(this.helper, constants.X_OK);
      await access("/usr/bin/sandbox-exec", constants.X_OK);
      return process.platform === "darwin";
    } catch {
      return false;
    }
  }

  capabilities() {
    const unavailable = "capability_unavailable" as const;
    return {
      schema: 1 as const,
      adapterId: "suri-pi-review-queue/3",
      operations: {
        launch_fresh: "supported",
        resume_same: unavailable,
        prompt_receipt: unavailable,
        durable_cursor: unavailable,
        context_usage: unavailable,
        compact_receipt: unavailable,
        terminal_compaction_event: unavailable,
        suspend_writer: "supported",
        resume_writer: "supported",
        prove_quiescent: "supported",
        launch_reviewer_readonly: "supported",
        immutable_candidate: "supported",
        abort: unavailable,
        close: unavailable,
        bounded_result: unavailable,
      } as const,
    };
  }

  async launchImplementer(
    key: string,
    input: {
      repository: string;
      epoch: number;
      authority: QueueAuthority;
      hostWorkerSessionId: string;
    },
  ): Promise<QueueReceipt> {
    const repository = await realpath(input.repository);
    const authority = await canonicalAuthority(input.authority);
    if (authority.repository !== repository)
      throw new ReviewQueueRuntimeError(
        "source_authority_mismatch",
        "The authenticated workspace does not match the queue repository.",
      );
    const payload = { ...input, repository, authority };
    const prior = this.receipts.get(key);
    if (prior) return this.once("launch_fresh", key, payload, () => ({}));
    const scope = authorityKey(authority);
    if (input.epoch <= (this.epochs.get(scope) ?? 0))
      throw new ReviewQueueRuntimeError(
        "stale_fencing_epoch",
        "Writer epoch must increase monotonically for this source.",
      );
    return this.once("launch_fresh", key, payload, () => {
      this.epochs.set(scope, input.epoch);
      const id = `queue-impl-${randomUUID()}`;
      this.sessions.set(id, {
        id,
        role: "implementer",
        epoch: input.epoch,
        repository,
        hostWorkerSessionId: input.hostWorkerSessionId,
        authority,
        writer: true,
        inFlightMutations: 0,
        mutationTail: Promise.resolve(),
        activeProcesses: new Set(),
        closed: false,
      });
      return {
        sessionId: id,
        data: { fresh: true, role: "implementer", epoch: input.epoch },
      };
    });
  }

  async launchReviewer(
    key: string,
    input: {
      implementerSessionId: string;
      candidateRoot: string;
      candidateDigest: string;
      scratchRoot: string;
      epoch: number;
      authority: QueueAuthority;
      hostWorkerSessionId: string;
    },
  ): Promise<QueueReceipt> {
    const authority = await canonicalAuthority(input.authority);
    const writer = this.authorizedSession(
      input.implementerSessionId,
      authority,
    );
    if (writer.writer || writer.inFlightMutations !== 0)
      throw new ReviewQueueRuntimeError(
        "writer_not_quiescent",
        "Writer must be revoked and drained before review.",
      );
    this.assertEpoch(writer, input.epoch);
    const candidate = await realpath(input.candidateRoot);
    if (candidate !== authority.repository)
      throw new ReviewQueueRuntimeError(
        "source_authority_mismatch",
        "The review candidate is not the authenticated workspace.",
      );
    const scratch = resolve(input.scratchRoot);
    const scratchReal = await secureDirectory(
      this.helper,
      this.storageRoot,
      scratch,
    );
    if (candidate === scratchReal || contains(candidate, scratchReal))
      throw new ReviewQueueRuntimeError(
        "path_overlap",
        "Reviewer scratch must be outside the immutable candidate.",
      );
    const snapshot = await snapshotCandidate(
      candidate,
      this.snapshotRoot,
      input.candidateDigest,
      this.helper,
      this.storageRoot,
    );
    return this.once(
      "launch_reviewer",
      key,
      {
        ...input,
        authority,
        candidateRoot: candidate,
        scratchRoot: scratchReal,
      },
      () => {
        const id = `queue-review-${randomUUID()}`;
        this.sessions.set(id, {
          id,
          role: "reviewer",
          epoch: input.epoch,
          repository: snapshot,
          candidate: input.candidateDigest,
          scratch: scratchReal,
          hostWorkerSessionId: input.hostWorkerSessionId,
          authority,
          writer: false,
          inFlightMutations: 0,
          mutationTail: Promise.resolve(),
          activeProcesses: new Set(),
          closed: false,
        });
        return {
          sessionId: id,
          data: {
            fresh: true,
            role: "reviewer",
            readonly: true,
            immutableCandidate: input.candidateDigest,
          },
        };
      },
    );
  }

  suspendWriter(
    sessionId: string,
    epoch: number,
    authority: QueueAuthority,
  ): QueueReceipt {
    const session = this.authorizedSession(sessionId, authority);
    this.assertEpoch(session, epoch);
    session.writer = false;
    return this.receipt(
      "suspend_writer",
      `${sessionId}:${epoch}:suspend`,
      {},
      { sessionId },
    );
  }
  resumeWriter(
    sessionId: string,
    epoch: number,
    authority: QueueAuthority,
  ): QueueReceipt {
    const session = this.authorizedSession(sessionId, authority);
    this.assertEpoch(session, epoch);
    if (session.role !== "implementer")
      throw new ReviewQueueRuntimeError(
        "role_denied",
        "Only implementers can receive writer capability.",
      );
    session.writer = true;
    return this.receipt(
      "resume_writer",
      `${sessionId}:${epoch}:resume`,
      {},
      { sessionId },
    );
  }
  proveQuiescent(
    sessionId: string,
    epoch: number,
    authority: QueueAuthority,
  ): QueueReceipt {
    const session = this.authorizedSession(sessionId, authority);
    this.assertEpoch(session, epoch);
    if (session.writer || session.inFlightMutations)
      throw new ReviewQueueRuntimeError(
        "liveness_unknown",
        "Mutation capability is active or has not drained.",
      );
    return this.receipt(
      "prove_quiescent",
      `${sessionId}:${epoch}:quiescent`,
      {},
      { sessionId, data: { writerRevoked: true, drained: true } },
    );
  }

  async read(sessionId: string, target: string): Promise<string> {
    const session = this.session(sessionId);
    const path = safeRelative(target);
    const result = await runBounded(this.helper, [
      "queue-read",
      session.repository,
      path,
    ]);
    if (result.code === 9)
      throw new ReviewQueueRuntimeError(
        "read_limit_exceeded",
        "Read exceeds 1 MiB.",
      );
    if (result.code !== 0)
      throw new ReviewQueueRuntimeError(
        "path_denied",
        "Descriptor-relative read was denied.",
      );
    return result.stdout.toString("utf8");
  }

  async mutate(
    sessionId: string,
    epoch: number,
    target: string,
    bytes: string,
  ): Promise<void> {
    const session = this.session(sessionId);
    this.assertEpoch(session, epoch);
    if (!session.writer)
      throw new ReviewQueueRuntimeError(
        session.role === "reviewer"
          ? "reviewer_write_denied"
          : "writer_revoked",
        "Mutation capability is unavailable.",
      );
    await this.withMutation(session, epoch, async () => {
      const result = await runBounded(
        this.helper,
        ["queue-write", session.repository, safeRelative(target)],
        Buffer.from(bytes),
      );
      if (result.code !== 0)
        throw new ReviewQueueRuntimeError(
          "path_denied",
          "Descriptor-relative write was denied.",
        );
    });
  }

  async execute(
    sessionId: string,
    epoch: number,
    executable: string,
    args: string[],
  ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const session = this.session(sessionId);
    this.assertEpoch(session, epoch);
    if (!session.writer || session.role !== "implementer")
      throw new ReviewQueueRuntimeError(
        session.role === "reviewer"
          ? "reviewer_execute_denied"
          : "writer_revoked",
        "Subprocess capability is unavailable.",
      );
    if (
      !isAbsolute(executable) ||
      executable.includes("\0") ||
      args.some((arg) => arg.includes("\0"))
    )
      throw new ReviewQueueRuntimeError(
        "process_denied",
        "An absolute executable and NUL-free argv are required.",
      );
    // An unresolvable executable becomes "" and is denied by assertAdmittedExecutable.
    const canonicalExecutable = await realpath(executable).catch(() => "");
    return this.withMutation(session, epoch, async () => {
      // Admission is inside the mutation ledger so another mediated write cannot
      // replace the checked path before spawn.
      await assertAdmittedExecutable(canonicalExecutable);
      const temp = join(session.repository, ".suri-queue-tmp");
      const write = await runBounded(this.helper, [
        "queue-write",
        session.repository,
        ".suri-queue-tmp/.keep",
      ]);
      if (write.code !== 0)
        throw new ReviewQueueRuntimeError(
          "path_denied",
          "Queue temp setup failed.",
        );
      const profile = seatbeltProfile(session.repository, canonicalExecutable);
      return await new Promise((done, reject) => {
        const child = spawn(
          "/usr/bin/sandbox-exec",
          ["-p", profile, canonicalExecutable, ...args],
          {
            cwd: session.repository,
            detached: true,
            env: {
              PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
              HOME: temp,
              TMPDIR: temp,
            },
            stdio: ["ignore", "pipe", "pipe"],
          },
        );
        session.activeProcesses.add(child);
        let stdout = "";
        let stderr = "";
        const append = (old: string, chunk: Buffer) =>
          (old + chunk.toString("utf8")).slice(-1024 * 1024);
        child.stdout.on("data", (chunk) => (stdout = append(stdout, chunk)));
        child.stderr.on("data", (chunk) => (stderr = append(stderr, chunk)));
        child.once("error", (error) => {
          session.activeProcesses.delete(child);
          reject(error);
        });
        child.once("close", (code, signal) => {
          session.activeProcesses.delete(child);
          if (signal)
            reject(
              new ReviewQueueRuntimeError(
                "process_interrupted",
                `Sandboxed process ended with ${signal}.`,
              ),
            );
          else done({ exitCode: code ?? 1, stdout, stderr });
        });
      });
    });
  }

  async writeReviewerResult(
    sessionId: string,
    target: string,
    bytes: string,
  ): Promise<void> {
    const session = this.session(sessionId);
    if (session.role !== "reviewer" || !session.scratch)
      throw new ReviewQueueRuntimeError(
        "role_denied",
        "Reviewer result storage is unavailable.",
      );
    const result = await runBounded(
      this.helper,
      ["queue-write", session.scratch, safeRelative(target)],
      Buffer.from(bytes),
    );
    if (result.code !== 0)
      throw new ReviewQueueRuntimeError(
        "path_denied",
        "Descriptor-relative result write was denied.",
      );
  }

  close(sessionId: string) {
    const session = this.session(sessionId);
    session.closed = true;
    session.writer = false;
    for (const child of session.activeProcesses) {
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }
  }

  private async withMutation<T>(
    session: Session,
    epoch: number,
    operation: () => Promise<T>,
  ): Promise<T> {
    session.inFlightMutations++;
    const previous = session.mutationTail;
    let release!: () => void;
    session.mutationTail = new Promise<void>((resolve) => (release = resolve));
    await previous;
    try {
      this.assertEpoch(session, epoch);
      if (!session.writer || session.role !== "implementer")
        throw new ReviewQueueRuntimeError(
          session.role === "reviewer"
            ? "reviewer_write_denied"
            : "writer_revoked",
          "Mutation capability is unavailable.",
        );
      return await operation();
    } finally {
      session.inFlightMutations--;
      release();
    }
  }
  private session(id: string) {
    const value = this.sessions.get(id);
    if (!value || value.closed)
      throw new ReviewQueueRuntimeError(
        "session_lost",
        "Session is unavailable.",
      );
    return value;
  }
  private authorizedSession(id: string, authority: QueueAuthority) {
    const value = this.session(id);
    if (authorityKey(value.authority) !== authorityKey(authority))
      throw new ReviewQueueRuntimeError(
        "source_authority_mismatch",
        "Queue authority belongs to another authenticated source.",
      );
    return value;
  }
  private assertEpoch(session: Session, epoch: number) {
    if (session.epoch !== epoch)
      throw new ReviewQueueRuntimeError(
        "stale_fencing_epoch",
        "Stale writer epoch.",
      );
  }
  private once(
    operation: string,
    key: string,
    payload: unknown,
    create: () => { sessionId?: string; data?: Record<string, unknown> },
  ) {
    const payloadDigest = digest(payload);
    const old = this.receipts.get(key);
    if (old) {
      if (old.operation !== operation || old.payloadDigest !== payloadDigest)
        throw new ReviewQueueRuntimeError(
          "request_payload_mismatch",
          "Idempotency key payload changed.",
        );
      return old;
    }
    const receipt: QueueReceipt = {
      schema: 1,
      operation,
      key,
      payloadDigest,
      status: "accepted",
      ...create(),
    };
    this.receipts.set(key, receipt);
    return receipt;
  }
  private receipt(
    operation: string,
    key: string,
    payload: unknown,
    extra: Partial<QueueReceipt>,
  ): QueueReceipt {
    return {
      schema: 1,
      operation,
      key,
      payloadDigest: digest(payload),
      status: "completed",
      ...extra,
    };
  }
}
