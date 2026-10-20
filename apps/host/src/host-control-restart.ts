import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import type { Socket } from "node:net";
import { SuriError } from "../../../packages/protocol/src/index.js";
import { claimLegacyMigration } from "./legacy-migration.js";
import { writeUpdateFile } from "./update-state.js";
import { reportDiagnostic } from "./safe-diagnostics.js";
import type { RestartControlCaps, HostControl } from "./host-control.js";

/**
 * The control-socket connection handler. The single async data handler (all
 * awaits and the try/catch frame) lives here as one function; synchronous
 * branch bodies are called from `basic` at their positions in the dispatch chain.
 */
export function createControlConnection(
  caps: RestartControlCaps,
  basic: HostControl,
) {
  return (socket: Socket) => {
    let data = "";
    socket.on("data", async (chunk) => {
      data += chunk;
      if (data.length > 16384) {
        socket.destroy();
        return;
      }
      if (!data.includes("\n")) return;
      try {
        const p = JSON.parse(data.split("\n")[0]);
        if (p.type === "bootstrap") {
          basic.bootstrap(socket, p);
        } else if (p.type === "health") {
          basic.health(socket);
        } else if (
          caps.closing() &&
          ["updates-status", "associate-updates"].includes(p.type)
        ) {
          socket.end('{"error":"HOST_STOPPING"}\n');
        } else if (p.type === "browser-rendezvous" && caps.modernUpdates()) {
          if (caps.closing() || typeof p.clientInstanceId !== "string") {
            socket.end('{"checkpointed":false}\n');
            return;
          }
          socket.end(
            JSON.stringify({
              checkpointed: await caps
                .modernUpdates()!
                .requestBrowserOpen(p.clientInstanceId),
            }) + "\n",
          );
        } else if (p.type === "legacy-migrate-admit" && !caps.modernUpdates()) {
          try {
            const status = await caps.updateStatus.snapshot(
              caps.instanceId,
              caps.store.epoch,
            );
            basic.legacyAdmitGuard(p, status);
            // Close every non-observational admission path synchronously before
            // the persisted claim yields. Recheck the shared registry while the
            // gate is held; rollback only when no claim was persisted.
            caps.setClosing(true);
            if (caps.activeWork() > 0) {
              caps.setClosing(false);
              throw new SuriError(
                "HOST_BUSY",
                "Protected work appeared before migration admission.",
                true,
              );
            }
            try {
              await (caps.options.migrationClaim ?? claimLegacyMigration)(
                caps.options.root,
                p,
                caps.options.helper,
              );
            } catch (error) {
              caps.setClosing(false);
              throw error;
            }
            for (const session of caps.store.list("session"))
              caps.idle(session.id);
            const stopAdmittedHost = () => {
              setTimeout(() => {
                void caps
                  .close()
                  .catch(() =>
                    reportDiagnostic("shutdown", "HOST_SHUTDOWN_FAILED"),
                  );
              }, 100);
            };
            // Durable admission owns shutdown. Scheduling cannot depend on the
            // peer receiving or acknowledging the response.
            stopAdmittedHost();
            if (
              caps.options.simulated &&
              process.env.SURI_TEST_DROP_MIGRATION_ADMISSION_RESPONSE === "1"
            )
              socket.destroy();
            else
              socket.end(
                JSON.stringify({
                  stopping: true,
                  instanceId: caps.instanceId,
                  pid: process.pid,
                  profileId: status.profileId,
                  origin: caps.origin(),
                }) + "\n",
              );
          } catch (error) {
            const code =
              error instanceof Error && "code" in error
                ? String(error.code)
                : "MIGRATION_ADMISSION_FAILED";
            socket.end(JSON.stringify({ error: code }) + "\n");
          }
        } else if (p.type === "restart-handoff-status" && caps.lifecycle()) {
          try {
            basic.handoffStatusGuard(p);
            const committed = await caps
              .lifecycle()!
              .handoffs.isBound(
                p.operationId,
                p.targetBuildId,
                caps.instanceId,
              );
            socket.end(JSON.stringify({ committed }) + "\n");
          } catch (error) {
            const code =
              error instanceof Error && "code" in error
                ? String(error.code)
                : "HANDOFF_UNAVAILABLE";
            socket.end(JSON.stringify({ error: code }) + "\n");
          }
        } else if (p.type === "restart-handoff-revoke" && caps.lifecycle()) {
          try {
            basic.handoffRevokeGuard(p);
            const revoked = await caps
              .lifecycle()!
              .handoffs.revoke(p.operationId);
            if (revoked) {
              caps.transport.revokeRestartOperation(p.operationId);
            }
            socket.end(JSON.stringify({ revoked }) + "\n");
          } catch (error) {
            const code =
              error instanceof Error && "code" in error
                ? String(error.code)
                : "HANDOFF_REVOKE_FAILED";
            socket.end(JSON.stringify({ error: code }) + "\n");
          }
        } else if (p.type === "restart-handoff-commit" && caps.lifecycle()) {
          try {
            const { targetIdentity, uiBuildId } = basic.handoffCommitGuard(p);
            await caps
              .lifecycle()!
              .handoffs.commit(
                p.operationId,
                p.targetBuildId,
                caps.instanceId,
                () =>
                  writeUpdateFile(
                    join(
                      caps.options.root,
                      "run",
                      `restart-${p.operationId}.json`,
                    ),
                    JSON.stringify({
                      operationId: p.operationId,
                      workerPid: p.workerPid,
                      at: new Date().toISOString(),
                      targetBuildId: targetIdentity.buildId,
                      fromInstanceId: p.fromInstanceId,
                      stage: "complete",
                      code: "VERIFIED",
                      oldHostState: p.oldHostState,
                      retryable: false,
                      action: "none",
                      instanceId: caps.instanceId,
                      pid: process.pid,
                      hostBuildId: targetIdentity.buildId,
                      uiBuildId,
                      uiContract: 2,
                    }),
                  ),
              );
            if (
              caps.options.simulated &&
              process.env.SURI_TEST_DROP_HANDOFF_COMMIT_RESPONSE === "1"
            )
              socket.destroy();
            else socket.end('{"committed":true}\n');
          } catch (error) {
            const code =
              error instanceof Error && "code" in error
                ? String(error.code)
                : "HANDOFF_UNAVAILABLE";
            socket.end(JSON.stringify({ error: code }) + "\n");
          }
        } else if (p.type === "updates-restart" && caps.lifecycle()) {
          try {
            if (caps.closing())
              throw new SuriError("HOST_STOPPING", "Host admission is closed.");
            if (!caps.launchIdentity)
              throw new SuriError(
                "RETAINED_LAUNCHER_REQUIRED",
                "Restart requires a retained verified launcher.",
              );
            let result;
            if (p.action === "cancel" && typeof p.operationId === "string")
              result = await caps.lifecycle()!.restart.cancel(p.operationId);
            else if (
              p.action === "approve" &&
              p.confirm === true &&
              /^[a-f0-9]{64}$/.test(p.targetBuildId ?? "") &&
              Number.isSafeInteger(p.generation) &&
              ["now", "when-idle"].includes(p.mode)
            )
              result = await caps
                .lifecycle()!
                .restart.approve(
                  p.targetBuildId,
                  p.mode,
                  p.generation,
                  caps.activeWork() === 0,
                );
            else
              throw new SuriError(
                "VALIDATION",
                "Explicit target approval is required.",
              );
            socket.end(JSON.stringify(result) + "\n");
          } catch (error) {
            const code =
              error instanceof Error && "code" in error
                ? String(error.code)
                : "RESTART_CONTROL_FAILED";
            socket.end(JSON.stringify({ error: code }) + "\n");
          }
        } else if (p.type === "restart-admit" && caps.lifecycle()) {
          if (caps.closing()) {
            socket.end('{"error":"HOST_STOPPING"}\n');
            return;
          }
          try {
            await caps
              .lifecycle()!
              .restart.prepareAdmission(
                p.operationId,
                p.expectedInstanceId,
                p.targetBuildId,
              );
            caps.lifecycle()!.restart.assertAdmission(p.operationId);
            if (caps.activeWork() > 0) {
              await caps.lifecycle()!.restart.busyAdmission();
              socket.end('{"error":"HOST_BUSY"}\n');
              return;
            }
            // No await between the final shared registry check and admission.
            caps.setClosing(true);
            for (const session of caps.store.list("session"))
              caps.idle(session.id);
            socket.end(
              JSON.stringify({ stopping: true, instanceId: caps.instanceId }) +
                "\n",
            );
            setImmediate(() => {
              void caps
                .close()
                .catch(() =>
                  reportDiagnostic("shutdown", "HOST_SHUTDOWN_FAILED"),
                );
            });
          } catch (error) {
            const code =
              error instanceof Error && "code" in error
                ? String(error.code)
                : "RESTART_ADMISSION_FAILED";
            socket.end(JSON.stringify({ error: code }) + "\n");
          }
        } else if (p.type === "updates-status") {
          caps.beginUpdateControl();
          try {
            socket.end(
              JSON.stringify(
                caps.modernUpdates()
                  ? (await caps.modernUpdates()!.reconcile(),
                    caps.modernUpdates()!.snapshot())
                  : await caps.updateStatus.snapshot(
                      caps.instanceId,
                      caps.store.epoch,
                    ),
              ) + "\n",
            );
          } catch (error) {
            const code =
              error instanceof Error && "code" in error
                ? error.code
                : "INTERNAL_UNCLASSIFIED";
            socket.end(
              JSON.stringify({
                error:
                  code === "UPDATE_STATE_CORRUPT"
                    ? code
                    : code === "STORAGE_UNAVAILABLE"
                      ? code
                      : "UPDATE_RECONCILE_FAILED",
              }) + "\n",
            );
          } finally {
            caps.endUpdateControl();
          }
        } else if (
          p.type === "associate-updates" &&
          typeof p.path === "string" &&
          p.path.startsWith("/")
        ) {
          caps.beginUpdateControl();
          try {
            if (caps.modernUpdates())
              await caps.modernUpdates()!.associate(p.path);
            else await caps.updateStatus.associate(p.path);
            socket.end('{"associated":true}\n');
          } catch (error) {
            const code =
              error instanceof Error && "code" in error
                ? String(error.code)
                : "CHECKOUT_CHANGED";
            socket.end(
              JSON.stringify({
                error: [
                  "CHECKOUT_CHANGED",
                  "UPDATE_STATE_CORRUPT",
                  "STORAGE_UNAVAILABLE",
                  "UPDATE_CONFLICT",
                ].includes(code)
                  ? code
                  : "CHECKOUT_CHANGED",
              }) + "\n",
            );
          } finally {
            caps.endUpdateControl();
          }
        } else if (
          p.type === "associate-ui" &&
          typeof p.path === "string" &&
          p.path.startsWith("/")
        ) {
          caps.setUiCheckout(p.path);
          await writeFile(
            join(caps.options.root, "ui-checkout.json"),
            JSON.stringify({ path: p.path }),
            { mode: 0o600 },
          );
          socket.end('{"associated":true}\n');
        } else if (
          p.type === "grant" &&
          ["directory", "file", "executable"].includes(p.kind) &&
          typeof p.path === "string" &&
          p.path.startsWith("/")
        ) {
          basic.grant(socket, p);
        } else if (
          p.type === "runtime-validation-grant" &&
          p.confirmProviderSpend === true &&
          typeof p.provider === "string" &&
          p.provider.length > 0 &&
          typeof p.model === "string" &&
          p.model.length > 0 &&
          typeof p.agentDir === "string" &&
          p.agentDir.startsWith("/")
        ) {
          basic.runtimeValidationGrant(socket, p);
        } else socket.end('{"error":"UNKNOWN_CONTROL"}\n');
      } catch {
        socket.destroy();
      }
    });
  };
}
