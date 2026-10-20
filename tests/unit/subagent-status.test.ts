import { describe, expect, it } from "vitest";
import { parseSubagentStatus } from "../../apps/web/src/components/subagent-status.js";

const prefix = "PI_SUBAGENT_ASYNC_JSON:";
const snapshot = (runs: unknown[], omitted = { runs: 0, children: 0 }) => [
  prefix +
    JSON.stringify({
      kind: "pi-subagents.async-status-snapshot",
      version: 1,
      generatedAt: 1,
      caps: { maxRuns: 20 },
      omitted,
      runs,
    }),
];

describe("pi-subagents widget projection", () => {
  it("reads bounded status, nested steps, and activity without surfacing transport fields", () => {
    expect(
      parseSubagentStatus(
        snapshot([
          {
            id: "run",
            kind: "workflow",
            label: "worker",
            state: "running",
            children: [
              {
                id: "implement",
                kind: "step",
                label: "Implement vertical slice",
                state: "running",
                activity: {
                  turnCount: 6,
                  toolCount: 20,
                  currentTool: "bash",
                  extra: "not displayed",
                },
              },
            ],
          },
        ]),
      ),
    ).toEqual({
      runs: [
        {
          id: "run",
          kind: "workflow",
          label: "worker",
          state: "running",
          activity: {},
          children: [
            {
              id: "implement",
              kind: "step",
              label: "Implement vertical slice",
              state: "running",
              activity: { turnCount: 6, toolCount: 20, currentTool: "bash" },
              children: undefined,
            },
          ],
        },
      ],
      omittedRuns: 0,
      omittedChildren: 0,
    });
  });
  it("rejects malformed, oversized, and unknown versions instead of showing JSON", () => {
    expect(parseSubagentStatus([prefix + "{"])).toBeUndefined();
    expect(parseSubagentStatus([prefix + "x".repeat(50001)])).toBeUndefined();
    expect(
      parseSubagentStatus([
        prefix +
          JSON.stringify({
            kind: "pi-subagents.async-status-snapshot",
            version: 2,
            runs: [],
          }),
      ]),
    ).toBeUndefined();
    expect(parseSubagentStatus(["unrelated"])).toBeUndefined();
    expect(
      parseSubagentStatus(
        snapshot([
          { id: "run", label: "worker", kind: "workflow", state: "unknown" },
        ]),
      )?.runs,
    ).toEqual([]);
  });
});
