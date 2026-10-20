import { readFile } from "node:fs/promises";
import { describe, expect, test } from "vitest";

describe("portable verification", () => {
  test("builds before integration and excludes native/package acceptance", async () => {
    const source = await readFile("scripts/verify-portable.mjs", "utf8");
    const checks = [...source.matchAll(/^\s+"([^"]+)",$/gm)].map(
      (match) => match[1],
    );
    expect(checks.indexOf("build")).toBeGreaterThan(-1);
    expect(checks.indexOf("build")).toBeLessThan(
      checks.indexOf("test:integration"),
    );
    expect(checks).not.toContain("test:package");
    expect(checks).not.toContain("package:macos");
    expect(source).not.toContain("apps/macos");
    expect(source).not.toContain("verify.mjs");
  });
});
