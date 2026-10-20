import { describe, expect, test } from "vitest";
import { parseDoctorProcess } from "../../scripts/package-cli-contract.mjs";

const failure = (code: string, stage = "sqlite") => ({
  ok: false,
  stage,
  code,
  retryable: false,
  action: "Repair the bounded fixture before retrying.",
});

describe("installed CLI doctor stream contract", () => {
  test("accepts a successful preflight envelope on stdout", () => {
    expect(
      parseDoctorProcess({
        status: 0,
        signal: null,
        stdout:
          '{"preflight":{"ok":true,"platform":"darwin","architecture":"arm64","node":"24.15.0"},"host":{"present":false}}\n',
        stderr: "",
      }),
    ).toMatchObject({ kind: "doctor", value: { preflight: { ok: true } } });
  });

  test.each(["SQLITE_ABI_UNAVAILABLE", "PTY_ABI_UNAVAILABLE"])(
    "accepts bounded %s preflight failure on stdout",
    (code) => {
      expect(
        parseDoctorProcess({
          status: 1,
          signal: null,
          stdout: JSON.stringify({ preflight: failure(code) }),
          stderr: "",
        }),
      ).toMatchObject({
        kind: "doctor",
        value: { preflight: { ok: false, code } },
      });
    },
  );

  test("accepts a complete direct startup failure only on stderr", () => {
    expect(
      parseDoctorProcess({
        status: 1,
        signal: null,
        stdout: "",
        stderr: JSON.stringify(failure("CHILD_EARLY_EXIT", "child")),
      }),
    ).toMatchObject({ kind: "failure", value: { code: "CHILD_EARLY_EXIT" } });
  });

  test.each([
    { status: 1, signal: null, stdout: "", stderr: "" },
    { status: 1, signal: null, stdout: "not json", stderr: "" },
    {
      status: 1,
      signal: null,
      stdout: '{"preflight":{"ok":true}}',
      stderr: "",
    },
    {
      status: 0,
      signal: null,
      stdout: '{"preflight":{"ok":true}}',
      stderr: "noise",
    },
    {
      status: null,
      signal: "SIGKILL",
      stdout: "",
      stderr: JSON.stringify(failure("CHILD_EARLY_EXIT", "child")),
    },
    {
      status: 1,
      signal: null,
      stdout: "",
      stderr: '{"ok":false,"stage":"child","code":"CHILD_EARLY_EXIT"}',
    },
    {
      status: 2,
      signal: null,
      stdout: "",
      stderr: JSON.stringify(failure("CHILD_EARLY_EXIT", "child")),
    },
  ])("rejects malformed, signalled, or contradictory output %#", (result) => {
    expect(() => parseDoctorProcess(result)).toThrow();
  });
});
