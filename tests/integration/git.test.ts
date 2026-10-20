import { it, expect } from "vitest";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { Resources } from "../../apps/host/src/resources.js";
it("reads real staged/unstaged diffs and existing worktrees without invoking external diff", async () => {
  const root = await mkdtemp(join(tmpdir(), "suri-git-"));
  const repo = join(root, "repo");
  await mkdir(repo);
  const git = (args: string[]) =>
    execFileSync("/usr/bin/git", ["-C", repo, ...args], { stdio: "pipe" });
  const resources = new Resources(resolve("dist/native/suri-helper"), () => {});
  try {
    git(["init"]);
    await writeFile(join(repo, "hello.txt"), "hello\n");
    git(["add", "hello.txt"]);
    git([
      "-c",
      "user.name=Suri fixture",
      "-c",
      "user.email=fixture@invalid",
      "commit",
      "-m",
      "fixture",
    ]);
    git(["worktree", "add", "-b", "fixture-branch", join(root, "second")]);
    await writeFile(join(repo, "hello.txt"), "hello world\n");
    git(["config", "diff.external", "/usr/bin/false"]);
    expect(
      (await resources.git(repo, "git.diff", { staged: false })).text,
    ).toContain("+hello world");
    expect((await resources.git(repo, "workspace.list", {})).text).toContain(
      join(root, "second"),
    );
    git(["add", "hello.txt"]);
    expect(
      (await resources.git(repo, "git.diff", { staged: true })).text,
    ).toContain("+hello world");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
