import { describe, expect, it } from "vitest";
import { failure, SuriError } from "../../packages/protocol/src/index.js";

describe("command failure receipts", () => {
  it("preserves an indeterminate outcome when an upstream effect may have run", () => {
    expect(
      failure(
        "request-1",
        new SuriError(
          "INDETERMINATE",
          "Pi response timed out; the operation will not be retried.",
        ),
      ),
    ).toMatchObject({
      status: "indeterminate",
      error: { code: "INDETERMINATE", retryable: false },
    });
  });

  it("keeps ordinary validation failures rejected", () => {
    expect(
      failure("request-2", new SuriError("VALIDATION", "Invalid request.")),
    ).toMatchObject({
      status: "rejected",
      error: { code: "VALIDATION" },
    });
  });
});
