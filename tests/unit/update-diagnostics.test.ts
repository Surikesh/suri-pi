import { it, expect } from "vitest";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { updateDiagnostics } from "../../apps/host/src/update-diagnostics.js";

it("offline feedback is bounded, historical, no-follow and excludes secrets and user content", async () => {
  const root = await mkdtemp(join(tmpdir(), "suri-update-diag-"));
  try {
    expect((await updateDiagnostics(root)).launch).toEqual({
      status: "ABSENT",
    });
    await mkdir(join(root, "run"));
    await mkdir(join(root, "updates"));
    await writeFile(
      join(root, "run/update-launch.json"),
      JSON.stringify({
        stage: "failed",
        code: "HOST_ADDRESS_CONFLICT",
        pid: 123,
        nonce: "private-nonce",
        message: "/private/profile/example",
        component: "host",
        line: 4,
      }),
    );
    await writeFile(
      join(root, "run/restart-execution.json"),
      "broken private-content",
    );
    await symlink(
      join(root, "run/update-launch.json"),
      join(root, "updates/restart.json"),
    );
    const result = await updateDiagnostics(root);
    expect(result.source).toBe("persisted-not-live");
    expect(result.launch).toEqual({
      status: "OBSERVED",
      stage: "failed",
      code: "HOST_ADDRESS_CONFLICT",
      pid: 123,
      component: "host",
      line: 4,
    });
    expect(result.restart).toEqual({ status: "INVALID" });
    expect(result.approval).toEqual({ status: "UNSAFE_FILE" });
    expect(JSON.stringify(result)).not.toMatch(/private|nonce|profile/);
    await writeFile(
      join(root, "run/update-launch.json"),
      JSON.stringify({
        stage: "failed",
        failedStage: "module-import",
        code: "HOST_MODULE_EVALUATION_FAILED",
        diagnostic: {
          component: "pi-adapter/index",
          errorType: "TypeError",
          line: 42,
          message: "private-nonce",
        },
      }),
    );
    expect((await updateDiagnostics(root)).launch).toEqual({
      status: "OBSERVED",
      stage: "failed",
      failedStage: "module-import",
      code: "HOST_MODULE_EVALUATION_FAILED",
      component: "pi-adapter/index",
      errorType: "TypeError",
      line: 42,
    });
    await writeFile(
      join(root, "run/restart-execution.json"),
      "x".repeat(65537),
    );
    expect((await updateDiagnostics(root)).restart).toEqual({
      status: "OVERSIZE",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
