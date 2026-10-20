import { describe, expect, it } from "vitest";
import {
  nextSessionPrompt,
  parseNextSessionArgument,
} from "../../apps/web/src/next-session.js";

describe("next session command", () => {
  it("parses a bounded workspace plan and derives a readable name", () => {
    expect(
      parseNextSessionArgument(
        "docs/plans/acme-project-runtime-activation-plan.md",
      ),
    ).toEqual({
      planPath: "docs/plans/acme-project-runtime-activation-plan.md",
      name: "Acme Project Runtime Activation Plan",
      dryRun: false,
    });
  });

  it("accepts explicit names, quoted paths, and dry runs", () => {
    expect(
      parseNextSessionArgument(
        '\"docs/plans/my plan.md\" --dry-run --name "Acme project activation"',
      ),
    ).toEqual({
      planPath: "docs/plans/my plan.md",
      name: "Acme project activation",
      dryRun: true,
    });
  });

  it.each(["", "/tmp/plan.md", "../plan.md", "docs/plan.txt", "docs\\plan.md"])(
    "rejects unsafe or unsupported plan path %j",
    (value) => expect(() => parseNextSessionArgument(value)).toThrow(),
  );

  it("builds a concise durable execution prompt", () => {
    const prompt = nextSessionPrompt("docs/plans/task.md");
    expect(prompt).toContain("docs/plans/task.md");
    expect(prompt).toContain("Preserve dirty work");
    expect(prompt).toContain("mandatory human gate");
    expect(prompt).toContain("telemetry as observational only");
    expect(prompt.length).toBeLessThan(600);
  });
});
