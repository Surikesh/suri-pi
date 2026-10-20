import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { launchVerifiedHost } from "./retained-hosts.js";
import {
  createLegacyMigration,
  finishLegacyMigration,
  markLegacyMigrationReplacementVerified,
  markLegacyMigrationSourceStopped,
  readLegacyMigration,
  requestLegacyMigrationAdmission,
  runLegacyMigrationExclusive,
} from "./legacy-migration.js";
import { CliFailure, fail, helper, root } from "./cli-env.js";
import { control } from "./cli-control.js";

// Structural views of control replies; fields are compared, never coerced.
type HealthView = {
  instanceId: string;
  pid: number;
  hostBuildId?: unknown;
  uiBuildId?: unknown;
  uiContract?: unknown;
  activeWork?: unknown;
};
type StatusView = {
  profileId: string;
  runningHost: { instanceId?: unknown; provenance: string };
};

export async function migrateLegacyHost(
  targetBuildId: string,
  uiBuildId: string,
) {
  return runLegacyMigrationExclusive(root, helper, async () => {
    const activeStates = new Set([
      "pending",
      "admission-requested",
      "admitted",
      "source-stopped",
      "replacement-verified",
    ]);
    let approval = await readLegacyMigration(root);
    const observe = async (
      admittedShutdown = false,
    ): Promise<{ health: HealthView; status: StatusView | null } | null> => {
      let health: HealthView;
      try {
        health = await control(root, { type: "health" });
      } catch (error) {
        if (error instanceof CliFailure) {
          if (error.detail.code === "CONTROL_UNAVAILABLE") return null;
          // After durable admission an empty/closing control response is
          // indeterminate, not failure or proof that ownership was released.
          // Keep polling the exact admitted identity until the socket vanishes.
          if (
            admittedShutdown &&
            ["HOST_STOPPING", "CONTROL_INVALID_RESPONSE"].includes(
              error.detail.code,
            )
          )
            return {
              health: {
                instanceId: approval!.expectedInstanceId,
                pid: approval!.expectedPid,
              },
              status: null,
            };
        }
        throw error;
      }
      try {
        return {
          health,
          status: await control(root, { type: "updates-status" }),
        };
      } catch (error) {
        if (error instanceof CliFailure) {
          if (
            error.detail.code === "HOST_STOPPING" ||
            (admittedShutdown &&
              error.detail.code === "CONTROL_INVALID_RESPONSE")
          )
            return { health, status: null };
          if (error.detail.code === "CONTROL_UNAVAILABLE") return null;
        }
        throw error;
      }
    };
    let observed = await observe();

    if (
      approval?.state === "succeeded" &&
      approval.targetBuildId === targetBuildId &&
      approval.uiBuildId === uiBuildId &&
      observed &&
      observed.health.instanceId === approval.replacementInstanceId &&
      observed.health.pid === approval.replacementPid &&
      observed.health.hostBuildId === targetBuildId &&
      observed.health.uiBuildId === uiBuildId &&
      observed.health.uiContract === 2 &&
      observed.status?.profileId === approval.profileId
    ) {
      console.log(
        JSON.stringify({
          migrated: true,
          operationId: approval.operationId,
          origin: approval.origin,
          fromInstanceId: approval.expectedInstanceId,
          instanceId: observed.health.instanceId,
          profileId: approval.profileId,
          hostBuildId: observed.health.hostBuildId,
          uiContract: observed.health.uiContract,
        }),
      );
      return;
    }

    if (
      approval &&
      activeStates.has(approval.state) &&
      (approval.targetBuildId !== targetBuildId ||
        approval.uiBuildId !== uiBuildId)
    )
      fail(
        "control",
        "MIGRATION_ALREADY_PENDING",
        false,
        "Resume the exact persisted migration target before selecting another target.",
      );

    // An expired request that was never admitted can be retired only while the
    // exact source is visibly still running. Expiry never overwrites admitted
    // authority or substitutes for proof of source/replacement state.
    if (
      approval &&
      ["pending", "admission-requested"].includes(approval.state) &&
      approval.expiresAt <= Date.now()
    ) {
      if (
        !observed ||
        observed.health.instanceId !== approval.expectedInstanceId ||
        observed.health.pid !== approval.expectedPid ||
        observed.health.uiContract !== 1
      )
        fail(
          "control",
          "MIGRATION_RECOVERY_REQUIRED",
          false,
          "The expired request cannot be retired without the exact source host proof.",
        );
      await finishLegacyMigration(
        root,
        approval.operationId,
        "failed",
        helper,
        undefined,
        "MIGRATION_APPROVAL_EXPIRED",
      );
      approval = null;
    }

    if (!approval || !activeStates.has(approval.state)) {
      if (
        !observed ||
        observed.health.uiContract !== 1 ||
        observed.health.hostBuildId !== null ||
        observed.status!.runningHost?.instanceId !==
          observed.health.instanceId ||
        !Number.isSafeInteger(observed.health.pid) ||
        observed.health.pid <= 1 ||
        observed.health.activeWork !== 0
      )
        fail(
          "control",
          observed?.health.activeWork
            ? "HOST_BUSY"
            : "MIGRATION_SOURCE_INVALID",
          false,
          "Migration requires the exact idle legacy host; it remains unchanged.",
        );
      const endpoint = await readFile(join(root, "run/endpoint.json"), "utf8")
        .then(JSON.parse)
        .catch((error) =>
          fail(
            "control",
            error.code === "ENOENT"
              ? "CONTROL_ENDPOINT_MISSING"
              : "CONTROL_ENDPOINT_INVALID",
            false,
            "The exact migration origin is unavailable; the host remains unchanged.",
          ),
        );
      const origin = new URL(endpoint.origin);
      if (
        origin.protocol !== "http:" ||
        origin.hostname !== "127.0.0.1" ||
        !origin.port ||
        origin.pathname !== "/" ||
        origin.search ||
        origin.hash
      )
        fail(
          "control",
          "CONTROL_ENDPOINT_INVALID",
          false,
          "Migration requires one canonical loopback origin with a nonzero port.",
        );
      approval = await createLegacyMigration(
        root,
        {
          schema: 1,
          state: "pending",
          operationId: randomUUID(),
          expectedPid: observed.health.pid,
          expectedInstanceId: observed.health.instanceId,
          profileId: observed.status!.profileId,
          origin: endpoint.origin,
          sourceBuildId: null,
          sourceProvenance: observed.status!.runningHost?.provenance,
          targetBuildId,
          uiBuildId,
          expiresAt: Date.now() + 120_000,
        },
        helper,
      );
    }

    // A previously verified exact replacement makes rerunning the command
    // idempotent even when the original CLI died before printing success.
    if (
      observed &&
      observed.health.instanceId !== approval.expectedInstanceId &&
      observed.health.hostBuildId === targetBuildId &&
      observed.health.uiBuildId === uiBuildId &&
      observed.health.uiContract === 2 &&
      observed.status!.profileId === approval.profileId
    ) {
      if (approval.state === "admitted")
        approval = await markLegacyMigrationSourceStopped(
          root,
          approval.operationId,
          helper,
        );
      if (approval.state === "source-stopped")
        approval = await markLegacyMigrationReplacementVerified(
          root,
          approval.operationId,
          { pid: observed.health.pid, instanceId: observed.health.instanceId },
          helper,
        );
    }

    if (["pending", "admission-requested"].includes(approval.state)) {
      if (
        !observed ||
        observed.health.instanceId !== approval.expectedInstanceId ||
        observed.health.pid !== approval.expectedPid ||
        observed.health.uiContract !== 1
      )
        fail(
          "control",
          "MIGRATION_SOURCE_INVALID",
          false,
          "The exact source disappeared before durable migration admission.",
        );
      if (approval.state === "pending")
        approval = await requestLegacyMigrationAdmission(
          root,
          approval.operationId,
          helper,
        );
      try {
        const admitted = await control(root, {
          type: "legacy-migrate-admit",
          ...approval,
        });
        if (
          !admitted.stopping ||
          admitted.instanceId !== approval.expectedInstanceId ||
          admitted.pid !== approval.expectedPid ||
          admitted.profileId !== approval.profileId ||
          admitted.origin !== approval.origin
        )
          fail(
            "control",
            "MIGRATION_ADMISSION_REFUSED",
            false,
            "The exact legacy host was not admitted; do not launch a replacement.",
          );
      } catch (error) {
        const reconciled = await readLegacyMigration(root);
        if (
          !reconciled ||
          reconciled.operationId !== approval.operationId ||
          reconciled.state !== "admitted"
        ) {
          if (
            reconciled?.operationId === approval.operationId &&
            ["pending", "admission-requested"].includes(reconciled.state)
          )
            await finishLegacyMigration(
              root,
              approval.operationId,
              "failed",
              helper,
              undefined,
              "MIGRATION_ADMISSION_FAILED",
            );
          throw error;
        }
      }
      approval = (await readLegacyMigration(root))!;
      if (
        process.env.SURI_SIMULATED === "1" &&
        process.env.SURI_TEST_EXIT_MIGRATION_AT === "admitted"
      )
        process.exit(86);
    }

    observed = await observe(approval.state === "admitted");
    if (approval.state === "admitted") {
      for (let attempt = 0; observed && attempt < 150; attempt++) {
        if (
          observed.health.instanceId !== approval.expectedInstanceId ||
          observed.health.pid !== approval.expectedPid
        )
          break;
        await new Promise((done) => setTimeout(done, 100));
        observed = await observe(true);
      }
      if (
        observed &&
        observed.health.instanceId === approval.expectedInstanceId &&
        observed.health.pid === approval.expectedPid
      )
        fail(
          "control",
          "HOST_DRAIN_TIMEOUT",
          false,
          "The admitted host did not release ownership; the operation remains resumable.",
        );
      approval = await markLegacyMigrationSourceStopped(
        root,
        approval.operationId,
        helper,
      );
    }
    if (
      approval.state === "source-stopped" &&
      process.env.SURI_SIMULATED === "1" &&
      process.env.SURI_TEST_EXIT_MIGRATION_AT === "source-stopped"
    )
      process.exit(86);

    if (
      approval.state === "replacement-verified" &&
      (!observed ||
        observed.health.pid !== approval.replacementPid ||
        observed.health.instanceId !== approval.replacementInstanceId)
    )
      fail(
        "readiness",
        "MIGRATION_RECOVERY_REQUIRED",
        false,
        "The durably verified replacement is no longer the exact running host.",
      );

    let next: HealthView;
    if (
      observed &&
      observed.health.instanceId !== approval.expectedInstanceId &&
      observed.health.hostBuildId === targetBuildId &&
      observed.health.uiBuildId === uiBuildId &&
      observed.health.uiContract === 2 &&
      observed.status!.profileId === approval.profileId
    ) {
      next = observed.health;
    } else {
      if (observed)
        fail(
          "readiness",
          "HOST_IDENTITY_CHANGED",
          false,
          "A different host owns the migration origin; no replacement was launched.",
        );
      const launched = await launchVerifiedHost(
        root,
        targetBuildId,
        uiBuildId,
        approval.origin,
        () => control(root, { type: "health" }),
      );
      next = await control(root, { type: "health" });
      const nextStatus = await control(root, { type: "updates-status" });
      if (
        next.instanceId === approval.expectedInstanceId ||
        next.instanceId !== launched.instanceId ||
        next.pid !== launched.pid ||
        next.hostBuildId !== targetBuildId ||
        next.uiBuildId !== uiBuildId ||
        next.uiContract !== 2 ||
        nextStatus.profileId !== approval.profileId
      )
        fail(
          "readiness",
          "HOST_IDENTITY_CHANGED",
          false,
          "The replacement did not prove the exact migration tuple.",
        );
    }

    const grant = await control(root, { type: "bootstrap" });
    if (grant.origin !== approval.origin)
      fail(
        "readiness",
        "HOST_ADDRESS_CHANGED",
        false,
        "The replacement did not preserve the exact origin.",
      );
    const response = await fetch(grant.origin + "/v1/bootstrap", {
      method: "POST",
      headers: { Origin: grant.origin, "Content-Type": "application/json" },
      body: JSON.stringify({ nonce: grant.nonce }),
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok || !response.headers.has("set-cookie"))
      fail(
        "readiness",
        "HOST_REBOOTSTRAP_FAILED",
        false,
        "The exact replacement did not complete authenticated bootstrap.",
      );
    if (approval.state === "source-stopped")
      approval = await markLegacyMigrationReplacementVerified(
        root,
        approval.operationId,
        { pid: next.pid, instanceId: next.instanceId },
        helper,
      );
    if (
      approval.state === "replacement-verified" &&
      process.env.SURI_SIMULATED === "1" &&
      process.env.SURI_TEST_EXIT_MIGRATION_AT === "replacement-verified"
    )
      process.exit(86);
    if (approval.state === "replacement-verified")
      approval = await finishLegacyMigration(
        root,
        approval.operationId,
        "succeeded",
        helper,
        { pid: next.pid, instanceId: next.instanceId },
      );
    console.log(
      JSON.stringify({
        migrated: true,
        operationId: approval.operationId,
        origin: approval.origin,
        fromInstanceId: approval.expectedInstanceId,
        instanceId: next.instanceId,
        profileId: approval.profileId,
        hostBuildId: next.hostBuildId,
        uiContract: next.uiContract,
      }),
    );
  });
}
