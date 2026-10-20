import { afterEach, describe, expect, test, vi } from "vitest";
import { reportDiagnostic } from "../../apps/host/src/safe-diagnostics.js";

const sentinel = "synthetic-token-SHOULD-NOT-ESCAPE";

afterEach(() => vi.restoreAllMocks());

describe("safe diagnostics", () => {
  test("emits only an allowlisted category and correlation id", () => {
    const output: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...values) => {
      output.push(values.join(" "));
    });
    const hostile = new Error(sentinel, { cause: { token: sentinel } });
    hostile.stack = `stack ${sentinel}`;
    reportDiagnostic("command", "COMMAND_EXECUTION_FAILED");
    expect(output).toHaveLength(1);
    expect(output[0]).not.toContain(sentinel);
    expect(JSON.parse(output[0])).toMatchObject({
      product: "suri-pi",
      stage: "command",
      code: "COMMAND_EXECUTION_FAILED",
    });
  });
});
