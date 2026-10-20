import { randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { writeUpdateFile } from "./update-state.js";
import type { RestartBinding } from "./restart-handoff.js";
import {
  RestartApprovalSchema,
  RestartFailure,
  type RestartApproval,
  type RestartHooks,
} from "./restart-approval.js";
export { RestartFailure, type WorkState } from "./restart-approval.js";

export class RestartCoordinator {
  private current: RestartApproval | null = null;
  private acknowledged = new Set<string>();
  private barrierClosed = true;
  private processing?: Promise<void>;
  private timer?: ReturnType<typeof setInterval>;
  private stopped = false;
  private cancelledOperationId: string | null = null;
  private writes: Promise<unknown> = Promise.resolve();
  private readonly path: string;
  constructor(
    private readonly root: string,
    private readonly hooks: RestartHooks,
    private readonly now = Date.now,
  ) {
    this.path = join(root, "updates/restart.json");
  }
  async load() {
    await mkdir(join(this.root, "updates"), { recursive: true, mode: 0o700 });
    try {
      this.current = RestartApprovalSchema.parse(
        JSON.parse(await readFile(this.path, "utf8")),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        throw new RestartFailure("RESTART_STATE_CORRUPT");
    }
    if (
      this.current &&
      this.current.fromInstanceId !== this.hooks.instanceId &&
      !(
        this.current.phase === "admitted" &&
        this.current.targetBuildId === this.hooks.runningBuildId
      ) &&
      !["completed", "failed", "cancelled"].includes(this.current.phase)
    )
      await this.change({ phase: "cancelled", code: "HOST_INSTANCE_CHANGED" });
    return this;
  }
  snapshot() {
    return {
      approval: this.current ? { ...this.current } : null,
      work: this.hooks.work(),
      acknowledged: this.acknowledged.size,
      clients: this.hooks.clients().length,
    };
  }
  private async change(patch: Partial<RestartApproval>) {
    if (!this.current) throw new RestartFailure("RESTART_NOT_APPROVED");
    const next = RestartApprovalSchema.parse({ ...this.current, ...patch });
    const write = this.writes.then(async () => {
      await writeUpdateFile(this.path, JSON.stringify(next));
      if (this.current?.operationId === next.operationId) this.current = next;
    });
    // A failed state write stops further restart processing; the caller of change() still receives the failure.
    this.writes = write.catch(() => {
      this.stopped = true;
    });
    await write;
  }
  async approve(
    targetBuildId: string,
    mode: "now" | "when-idle",
    generation: number,
    idle = this.hooks.work().count === 0,
  ) {
    await this.writes;
    const target = this.hooks.target();
    if (
      !target ||
      target.buildId !== targetBuildId ||
      target.generation !== generation
    )
      throw new RestartFailure("HOST_TARGET_CHANGED");
    if (
      this.current &&
      !["completed", "cancelled", "failed"].includes(this.current.phase)
    )
      throw new RestartFailure("RESTART_ALREADY_APPROVED");
    // Called as a command; its own command/ingress are excluded by the caller.
    if (mode === "now" && !idle) throw new RestartFailure("HOST_BUSY");
    const next = RestartApprovalSchema.parse({
      operationId: randomUUID(),
      targetBuildId,
      uiBuildId: this.hooks.uiBuildId(),
      fromInstanceId: this.hooks.instanceId,
      profileId: this.hooks.profileId,
      origin: this.hooks.origin(),
      generation,
      approvedAt: this.now(),
      expiresAt: this.now() + 24 * 3600_000,
      phase: "waiting",
      code: null,
      barrierAt: null,
    });
    this.current = next;
    this.cancelledOperationId = null;
    try {
      await this.change({});
    } catch (error) {
      this.current = null;
      throw error;
    }
    this.acknowledged.clear();
    return this.snapshot();
  }
  async cancel(operationId: string, code: string | null = null) {
    this.operation(operationId);
    if (this.current!.phase === "admitted")
      throw new RestartFailure("HOST_STOPPING");
    this.cancelledOperationId = operationId;
    this.barrierClosed = true;
    await this.change({ phase: "cancelled", code });
    await this.hooks.handoffs.revoke(operationId);
    return this.snapshot();
  }
  binding(operationId: string, barrierId: string): RestartBinding {
    const operation = this.operation(operationId);
    if (
      this.barrierClosed ||
      !this.unchanged(operation) ||
      operation.phase !== "checkpoints" ||
      operation.barrierId !== barrierId
    )
      throw new RestartFailure("RESTART_BARRIER_CLOSED");
    return {
      operationId,
      targetBuildId: operation.targetBuildId,
      fromInstanceId: operation.fromInstanceId,
      profileId: operation.profileId,
      origin: operation.origin,
    };
  }
  acknowledge(operationId: string, clientId: string, barrierId: string) {
    this.binding(operationId, barrierId);
    this.acknowledged.add(clientId);
  }
  private operation(id: string) {
    if (!this.current || this.current.operationId !== id)
      throw new RestartFailure("RESTART_NOT_APPROVED");
    return this.current;
  }
  private unchanged(operation: RestartApproval) {
    const target = this.hooks.target();
    return (
      this.current?.operationId === operation.operationId &&
      this.cancelledOperationId !== operation.operationId &&
      target?.buildId === operation.targetBuildId &&
      target.generation === operation.generation &&
      operation.profileId === this.hooks.profileId &&
      operation.origin === this.hooks.origin() &&
      operation.fromInstanceId === this.hooks.instanceId &&
      operation.expiresAt > this.now()
    );
  }
  private async pause(code: string) {
    if (!this.current) return;
    this.barrierClosed = true;
    await this.hooks.handoffs.revoke(this.current.operationId);
    await this.change({
      phase: "waiting",
      code,
      barrierAt: null,
      barrierId: null,
    });
    this.acknowledged.clear();
  }
  async prepareAdmission(
    operationId: string,
    fromInstanceId: string,
    targetBuildId: string,
  ) {
    const operation = this.operation(operationId);
    if (
      operation.phase !== "dispatching" ||
      operation.fromInstanceId !== fromInstanceId ||
      operation.targetBuildId !== targetBuildId ||
      !this.unchanged(operation)
    )
      throw new RestartFailure("HOST_TARGET_CHANGED");
    if (!this.hooks.clients().every((id) => this.acknowledged.has(id)))
      throw new RestartFailure("CLIENT_STATE_UNSAVED");
    await this.change({ phase: "admitted" });
  }
  assertAdmission(operationId: string) {
    const operation = this.operation(operationId);
    if (operation.phase !== "admitted" || !this.unchanged(operation))
      throw new RestartFailure("HOST_TARGET_CHANGED");
    if (!this.hooks.clients().every((id) => this.acknowledged.has(id)))
      throw new RestartFailure("CLIENT_STATE_UNSAVED");
  }
  async busyAdmission() {
    await this.pause("HOST_BUSY");
  }
  start() {
    this.timer = setInterval(() => {
      void this.tick();
    }, 500);
    this.timer.unref();
  }
  async stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    await this.processing;
    await this.writes;
  }
  tick() {
    if (this.stopped) return Promise.resolve();
    if (!this.processing) {
      const operationId = this.current?.operationId;
      this.processing = this.advance()
        .catch(async (error) => {
          if (
            this.current &&
            this.current.operationId === operationId &&
            !["cancelled", "completed"].includes(this.current.phase)
          ) {
            await this.hooks.handoffs.revoke(this.current.operationId);
            if (this.current?.operationId !== operationId) return;
            await this.change({
              phase: "failed",
              code:
                error instanceof RestartFailure
                  ? error.code
                  : "RESTART_COORDINATOR_FAILED",
            });
          }
        })
        .catch(() => {
          this.stopped = true;
          if (this.current)
            this.current = {
              ...this.current,
              phase: "failed",
              code: "RESTART_STATE_WRITE_FAILED",
            };
        })
        .finally(() => {
          this.processing = undefined;
        });
    }
    return this.processing;
  }
  private async advance() {
    const operation = this.current;
    if (operation && ["dispatching", "admitted"].includes(operation.phase)) {
      // A missing or unreadable execution record is treated as no evidence (null) and handled by the timeout check below.
      const execution = await readFile(
        join(this.root, "run", "restart-" + operation.operationId + ".json"),
        "utf8",
      )
        .then(JSON.parse)
        .catch(() => null);
      if (
        this.current?.operationId !== operation.operationId ||
        this.current.phase !== operation.phase
      )
        return;
      if (
        this.now() - (operation.barrierAt ?? operation.approvedAt) > 60000 &&
        (execution?.operationId !== operation.operationId ||
          execution?.code === "PENDING")
      ) {
        this.barrierClosed = true;
        await this.hooks.handoffs.revoke(operation.operationId);
        if (this.current?.operationId === operation.operationId)
          await this.change({
            phase: "failed",
            code: "RESTART_WORKER_TIMEOUT",
          });
        return;
      }
      if (
        execution?.operationId === operation.operationId &&
        execution.targetBuildId === operation.targetBuildId &&
        execution.code !== "PENDING"
      ) {
        if (
          execution.code === "VERIFIED" &&
          execution.hostBuildId === operation.targetBuildId &&
          execution.uiBuildId === operation.uiBuildId &&
          execution.uiContract === 2 &&
          Number.isSafeInteger(execution.pid) &&
          execution.pid > 0 &&
          execution.instanceId !== operation.fromInstanceId &&
          (await this.hooks.handoffs.isBound(
            operation.operationId,
            operation.targetBuildId,
            execution.instanceId,
          ))
        )
          await this.change({ phase: "completed", code: null });
        else if (
          execution.code === "HOST_BUSY" &&
          operation.fromInstanceId === this.hooks.instanceId
        )
          await this.pause("HOST_BUSY");
        else
          await this.change({
            phase: "failed",
            code: /^[A-Z_]{1,80}$/.test(execution.code)
              ? execution.code
              : "RESTART_REPORT_INVALID",
          });
      }
    }
    if (
      !operation ||
      ["cancelled", "completed", "failed", "admitted", "dispatching"].includes(
        operation.phase,
      )
    )
      return;
    if (!this.unchanged(operation)) {
      await this.cancel(
        operation.operationId,
        operation.expiresAt <= this.now()
          ? "RESTART_APPROVAL_EXPIRED"
          : "HOST_TARGET_CHANGED",
      );
      return;
    }
    if (this.hooks.work().count && operation.phase === "waiting") return;
    if (operation.phase === "waiting") {
      await this.change({ phase: "preflight", code: null });
      await this.hooks.preflight(operation.targetBuildId);
      if (
        this.current?.operationId !== operation.operationId ||
        this.current.phase !== "preflight"
      )
        return;
      if (!this.unchanged(operation)) {
        await this.cancel(
          operation.operationId,
          operation.expiresAt <= this.now()
            ? "RESTART_APPROVAL_EXPIRED"
            : "HOST_TARGET_CHANGED",
        );
        return;
      }
      await this.change({
        phase: "checkpoints",
        barrierAt: this.now(),
        barrierId: randomUUID(),
      });
      this.acknowledged.clear();
      this.barrierClosed = false;
    }
    if (this.current?.phase !== "checkpoints") return;
    if (!this.hooks.clients().every((id) => this.acknowledged.has(id))) {
      if (this.now() - this.current.barrierAt! > 5000)
        await this.pause("CLIENT_STATE_UNSAVED");
      return;
    }
    if (this.hooks.work().count) {
      await this.pause("HOST_BUSY");
      return;
    }
    await this.change({ phase: "dispatching" });
    if (this.current?.operationId !== operation.operationId) return;
    if (!this.unchanged(operation)) {
      await this.cancel(
        operation.operationId,
        operation.expiresAt <= this.now()
          ? "RESTART_APPROVAL_EXPIRED"
          : "HOST_TARGET_CHANGED",
      );
      return;
    }
    await this.hooks.dispatch(this.current!);
  }
}
