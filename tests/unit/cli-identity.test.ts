import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  assertCompatibleHealth,
  assertShutdownReceipt,
  resolveLaunchFailure,
} from "../../apps/host/src/cli.js";

const compatible = {
  product: "suri-pi",
  protocol: 1,
  uiContract: 1,
  storageSchema: 1,
  capabilities: ["local-browser", "authenticated-bootstrap"],
  instanceId: "fixture-instance",
  lifecycle: "running",
};

describe("Local CLI host identity", () => {
  test("accepts the additive compatible identity", () => {
    expect(() =>
      assertCompatibleHealth({ ...compatible, future: true }),
    ).not.toThrow();
  });

  test.each([
    {},
    { ...compatible, product: "unknown" },
    { ...compatible, protocol: 2 },
    { ...compatible, capabilities: [] },
  ])(
    "fails closed without treating an unknown host as reusable",
    (identity) => {
      expect(() => assertCompatibleHealth(identity)).toThrow(
        "INCOMPATIBLE_HOST",
      );
    },
  );

  test("prefers available stage-specific status over an early child exit", async () => {
    const root = await mkdtemp(join(tmpdir(), "suri-launch-status-"));
    const status = join(root, "launch.json");
    try {
      await writeFile(
        status,
        JSON.stringify({
          ok: false,
          stage: "storage",
          code: "STORAGE_OPEN_FAILED",
          retryable: false,
          action: "Check profile storage permissions.",
        }),
      );
      await expect(
        resolveLaunchFailure(status, {
          ok: false,
          stage: "child",
          code: "CHILD_EARLY_EXIT",
          retryable: true,
          action: "Inspect the child.",
        }),
      ).resolves.toMatchObject({
        stage: "storage",
        code: "STORAGE_OPEN_FAILED",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("accepts only a terminal shutdown receipt bound to the old instance", () => {
    expect(() =>
      assertShutdownReceipt(
        {
          status: "completed",
          result: { stopping: true, instanceId: "fixture-instance" },
        },
        "fixture-instance",
      ),
    ).not.toThrow();
    expect(() =>
      assertShutdownReceipt(
        { status: "rejected", error: { code: "HOST_BUSY", retryable: true } },
        "fixture-instance",
      ),
    ).toThrow("HOST_BUSY");
    expect(() =>
      assertShutdownReceipt(
        {
          status: "completed",
          result: { stopping: true, instanceId: "unchanged-or-wrong" },
        },
        "fixture-instance",
      ),
    ).toThrow("SHUTDOWN_REJECTED");
  });
});
