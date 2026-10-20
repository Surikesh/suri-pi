import { describe, expect, it } from "vitest";
import {
  changedFilesByMessage,
  diffStats,
  parseGitStatus,
  parseDiff,
  untrackedDiff,
} from "../../apps/web/src/change-review.js";
import type { Message } from "../../packages/protocol/src/index.js";

function message(
  messageId: string,
  role: "user" | "assistant",
  blocks: Message["blocks"],
): Message {
  return { messageId, role, blocks, revision: 1, final: true };
}

describe("change review", () => {
  it("associates workspace edit tools with the following assistant response", () => {
    const messages = [
      message("user", "user", [{ id: "u", kind: "text", text: "Edit it" }]),
      message("activity", "assistant", [
        {
          id: "tool",
          kind: "toolCall",
          callId: "call",
          name: "edit",
          arguments: { path: "/workspace/src/long file.ts" },
        },
      ]),
      message("answer", "assistant", [
        { id: "text", kind: "text", text: "Done." },
      ]),
    ];
    expect(
      changedFilesByMessage(
        messages,
        { call: { name: "edit", phase: "completed", arguments: {} } },
        "/workspace",
      ).get("answer"),
    ).toEqual(["src/long file.ts"]);
  });

  it("parses modified, staged, renamed and untracked porcelain records", () => {
    const status = [
      "1 .M N... 100644 100644 100644 abc abc src/app.ts",
      "2 R. N... 100644 100644 100644 abc def R100 src/new name.ts",
      "src/old name.ts",
      "? notes/new.txt",
      "",
    ].join("\0");
    expect(parseGitStatus(status)).toEqual([
      {
        path: "notes/new.txt",
        code: "U",
        staged: false,
        unstaged: true,
        untracked: true,
      },
      {
        path: "src/app.ts",
        code: "M",
        staged: false,
        unstaged: true,
        untracked: false,
      },
      {
        path: "src/new name.ts",
        code: "R",
        staged: true,
        unstaged: false,
        untracked: false,
        renamedFrom: "src/old name.ts",
      },
    ]);
  });

  it("builds and counts an untracked text diff", () => {
    const diff = untrackedDiff("new.txt", "one\ntwo\n");
    expect(diff).toContain("@@ -0,0 +1,2 @@");
    expect(diffStats(diff)).toEqual({ additions: 2, deletions: 0 });
  });
});

it("numbers multiple hunks, zero ranges, signs in source and newline notes", () => {
  const rows = parseDiff(
    "diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -4,2 +4,2 @@ fn\n same\n---old\n+++new\n\\ No newline at end of file\n@@ -0,0 +9 @@\n+new",
  );
  expect(rows).toEqual([
    { kind: "hunk", text: "Lines 4 → 4 fn" },
    { kind: "context", text: "same", old: 4, new: 4 },
    { kind: "remove", text: "--old", old: 5 },
    { kind: "add", text: "++new", new: 5 },
    { kind: "note", text: "No newline at end of file" },
    { kind: "hunk", text: "Lines 0 → 9" },
    { kind: "add", text: "new", new: 9 },
  ]);
  expect(diffStats("@@ -1 +1 @@\n---old\n+++new")).toEqual({
    additions: 1,
    deletions: 1,
  });
  expect(parseDiff("diff --git a/a b/a\nBinary files differ")).toEqual([]);
  expect(diffStats(untrackedDiff("empty", ""))).toEqual({
    additions: 0,
    deletions: 0,
  });
});
it.each([
  "failed",
  "cancelled",
  "interrupted",
  "running",
  "pending",
  undefined,
])("does not advertise %s edits", (phase) => {
  expect(
    changedFilesByMessage(
      [
        message("answer", "assistant", [
          {
            id: "tool",
            kind: "toolCall",
            callId: "c",
            name: "edit",
            arguments: { path: "a.ts" },
          },
          { id: "text", kind: "text", text: "Result" },
        ]),
      ],
      { c: { phase } },
    ).size,
  ).toBe(0);
});
