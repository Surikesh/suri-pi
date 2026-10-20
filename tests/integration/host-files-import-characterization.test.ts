// Characterization (gap) tests for the file, asset, workspace, icon and
// session-import commands in host.ts executeUnlocked. They pin CURRENT
// behaviour, including oddities, so the H7 leaf-module extraction can be
// proven behaviour-preserving. Oddities are marked "ODDITY".
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { browserHost } from "../support/browser-host.js";
import { control } from "../../apps/host/src/cli.js";
import { Assets } from "../../apps/host/src/assets.js";

let fixture: Awaited<ReturnType<typeof browserHost>>;
let outside: string;
beforeAll(async () => {
  fixture = await browserHost(undefined, undefined, false);
  outside = await realpath(await mkdtemp(join(tmpdir(), "suri-files-out-")));
});
// Children of the SIGTERM-ignoring fixture runtimes are detached; if a test is
// interrupted or fails before product retirement finishes they would outlive
// the run (ppid 1). Record every such pid and SIGKILL its group on teardown.
const stubbornPids: number[] = [];
const killStubborn = () => {
  for (const pid of stubbornPids.splice(0))
    for (const target of [-pid, pid])
      try {
        process.kill(target, "SIGKILL");
      } catch {
        // Already gone.
      }
};
afterAll(async () => {
  killStubborn();
  await fixture?.close();
  if (outside) await rm(outside, { recursive: true, force: true });
});
const run = (
  type: string,
  payload: Record<string, unknown> = {},
  sessionId?: string,
  expectedRevision?: number,
) =>
  fixture.host.execute(
    {
      v: 1,
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      type,
      payload,
      sessionId,
      expectedRevision,
    },
    "fixture-client",
  );
const rejected = (code: string, message: string) => ({
  v: 1,
  id: expect.any(String),
  status: "rejected",
  error: { code, message, retryable: false },
});
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const fileGrant = async (path: string) =>
  (await control(fixture.data, { type: "grant", kind: "file", path })).grantId;
const history = (cwd: string, id = randomUUID()) =>
  JSON.stringify({ type: "session", version: 3, id, cwd, name: "Hist" }) + "\n";
const sessionIds = () => fixture.host.store.list("session").map((x) => x.id);
const runtimeDirs = () =>
  readdir(join(fixture.data, "runtime")).catch(() => [] as string[]);
const catalogSince = (seq: number) =>
  fixture.host.store.replay("catalog", seq) as {
    type: string;
    payload: any;
  }[];

it("file.list and file.read return helper-backed shapes and reject unsafe paths", async () => {
  const f = fixture;
  await mkdir(join(f.workspace, "sub"));
  await writeFile(join(f.workspace, "sub", "a.txt"), "a");
  await writeFile(join(f.workspace, "bin.dat"), Buffer.from([0, 1, 2]));
  await writeFile(join(outside, "target.txt"), "target\n");
  await symlink(join(outside, "target.txt"), join(f.workspace, "ln"));
  const ws = { workspaceId: f.workspaceId };

  const listing = await run("file.list", ws);
  expect(listing.status).toBe("completed");
  expect(listing.result).toEqual({
    entries: expect.arrayContaining([
      { name: "hello.txt", kind: "file" },
      { name: "bin.dat", kind: "file" },
      { name: "sub", kind: "directory" },
      { name: "ln", kind: "symlink" },
    ]),
    truncated: false,
  });
  expect(listing.result?.entries).toHaveLength(4);
  expect((await run("file.list", { ...ws, path: "sub" })).result).toEqual({
    entries: [{ name: "a.txt", kind: "file" }],
    truncated: false,
  });

  const text = "first line\nsecond line\n";
  expect((await run("file.read", { ...ws, path: "hello.txt" })).result).toEqual(
    {
      encoding: "utf8",
      content: text,
      bytes: 23,
      truncated: false,
      revision: sha(text),
    },
  );
  // A partial ranged read reports truncated:true and its revision hashes only
  // the returned slice; a range ending exactly at EOF is complete.
  expect(
    (await run("file.read", { ...ws, path: "hello.txt", offset: 6, length: 4 }))
      .result,
  ).toEqual({
    encoding: "utf8",
    content: "line",
    bytes: 4,
    truncated: true,
    revision: sha("line"),
  });
  expect(
    (
      await run("file.read", {
        ...ws,
        path: "hello.txt",
        offset: 6,
        length: 17,
      })
    ).result,
  ).toMatchObject({ content: "line\nsecond line\n", truncated: false });
  expect((await run("file.read", { ...ws, path: "bin.dat" })).result).toEqual({
    encoding: "base64",
    content: "AAEC",
    bytes: 3,
    truncated: false,
    revision: createHash("sha256")
      .update(Buffer.from([0, 1, 2]))
      .digest("hex"),
  });

  const unavailable = rejected(
    "PATH_DENIED",
    "The path is unavailable or contains a symbolic link.",
  );
  const outsideRoot = rejected(
    "PATH_DENIED",
    "Choose a path inside this workspace.",
  );
  expect(await run("file.read", { ...ws, path: "nope.txt" })).toEqual(
    unavailable,
  );
  expect(await run("file.read", { ...ws, path: "ln" })).toEqual(unavailable);
  expect(await run("file.read", { ...ws, path: "sub" })).toEqual(unavailable);
  // ODDITY: an empty path is normalised to "." and then fails as a directory.
  expect(await run("file.read", { ...ws, path: "" })).toEqual(unavailable);
  expect(await run("file.list", { ...ws, path: "hello.txt" })).toEqual(
    unavailable,
  );
  expect(await run("file.read", { ...ws, path: "../x" })).toEqual(outsideRoot);
  expect(await run("file.list", { ...ws, path: "/etc" })).toEqual(outsideRoot);
  expect(await run("file.read", { ...ws, path: "a\\b" })).toEqual(outsideRoot);
  expect(await run("file.read", { workspaceId: randomUUID() })).toEqual(
    rejected("NOT_FOUND", "workspace was not found."),
  );
  expect(await run("file.read", {})).toEqual(
    rejected("VALIDATION", "Invalid workspaceId."),
  );
});

it("externalFile.read reads a confirmed canonical absolute file and rejects the rest", async () => {
  const path = join(outside, "e.txt");
  await writeFile(path, "ext\n");
  await symlink(path, join(outside, "link.txt"));
  expect(
    (await run("externalFile.read", { path, confirmed: true })).result,
  ).toEqual({
    encoding: "utf8",
    content: "ext\n",
    bytes: 4,
    truncated: false,
    revision: sha("ext\n"),
  });
  expect(
    (
      await run("externalFile.read", {
        path,
        confirmed: true,
        offset: 1,
        length: 2,
      })
    ).result,
  ).toEqual({
    encoding: "utf8",
    content: "xt",
    bytes: 2,
    truncated: true,
    revision: sha("xt"),
  });
  const confirm = rejected(
    "PATH_DENIED",
    "Confirm access to this external file.",
  );
  expect(await run("externalFile.read", { path })).toEqual(confirm);
  expect(
    await run("externalFile.read", { path: "e.txt", confirmed: true }),
  ).toEqual(confirm);
  const changed = rejected(
    "PATH_DENIED",
    "The external file changed or is a symbolic link.",
  );
  for (const bad of [
    join(outside, "link.txt"),
    outside,
    `${outside}/../${outside.split("/").at(-1)}/e.txt`,
  ])
    expect(
      await run("externalFile.read", { path: bad, confirmed: true }),
    ).toEqual(changed);
  expect(
    await run("externalFile.read", {
      path: join(outside, "missing.txt"),
      confirmed: true,
    }),
  ).toEqual(rejected("NOT_FOUND", "External file is unavailable."));
  expect(await run("externalFile.read", { confirmed: true })).toEqual(
    rejected("VALIDATION", "Invalid path."),
  );
});

it("external file absence and permission errors disclose no filesystem details", async () => {
  const missing = join(outside, "nothing", "here.txt");
  const absent = await run("externalFile.read", {
    path: missing,
    confirmed: true,
  });
  expect(absent).toEqual(
    rejected("NOT_FOUND", "External file is unavailable."),
  );
  expect(JSON.stringify(absent)).not.toMatch(/ENOENT|nothing|\/tmp|\/var/);
  const locked = join(outside, "locked");
  await mkdir(locked);
  await writeFile(join(locked, "s.txt"), "secret\n");
  await chmod(locked, 0o000);
  try {
    const denied = await run("externalFile.read", {
      path: join(locked, "s.txt"),
      confirmed: true,
    });
    expect(denied).toEqual(
      rejected("PATH_DENIED", "External file access was denied."),
    );
    expect(JSON.stringify(denied)).not.toMatch(/EACCES|locked|s\.txt/);
  } finally {
    await chmod(locked, 0o700);
  }
});

it("file.write replaces content by revision and rejects stale, unsafe and invalid writes", async () => {
  const f = fixture;
  const ws = { workspaceId: f.workspaceId };
  const target = join(f.workspace, "hello.txt");
  const original = "first line\nsecond line\n";
  await writeFile(target, original);
  const revision = sha(original);

  const written = await run("file.write", {
    ...ws,
    path: "hello.txt",
    content: "new\n",
    expectedRevision: revision,
  });
  expect(written).toEqual({
    v: 1,
    id: expect.any(String),
    status: "completed",
    result: {
      encoding: "utf8",
      content: "new\n",
      bytes: 4,
      truncated: false,
      revision: sha("new\n"),
    },
  });
  expect(await readFile(target, "utf8")).toBe("new\n");

  // Same (now stale) revision again: conflict, disk untouched.
  expect(
    await run("file.write", {
      ...ws,
      path: "hello.txt",
      content: "new2\n",
      expectedRevision: revision,
    }),
  ).toEqual(
    rejected(
      "CONFLICT",
      "The file changed on disk. Reopen it before saving your edits.",
    ),
  );
  expect(await readFile(target, "utf8")).toBe("new\n");

  // Out-of-root, invalid payloads and unavailable targets.
  const current = sha("new\n");
  expect(
    await run("file.write", {
      ...ws,
      path: "/tmp/x",
      content: "x",
      expectedRevision: current,
    }),
  ).toEqual(rejected("PATH_DENIED", "Choose a path inside this workspace."));
  expect(
    await run("file.write", {
      ...ws,
      path: "hello.txt",
      content: 5,
      expectedRevision: current,
    }),
  ).toEqual(rejected("VALIDATION", "Invalid file content."));
  expect(
    await run("file.write", {
      ...ws,
      path: "hello.txt",
      content: "x".repeat(1048577),
      expectedRevision: current,
    }),
  ).toEqual(rejected("VALIDATION", "Invalid file content."));
  expect(
    await run("file.write", { ...ws, path: "hello.txt", content: "x" }),
  ).toEqual(rejected("VALIDATION", "Invalid expectedRevision."));
  // ODDITY: the write cannot create files; a missing target is PATH_DENIED.
  expect(
    await run("file.write", {
      ...ws,
      path: "fresh.txt",
      content: "x",
      expectedRevision: current,
    }),
  ).toEqual(
    rejected(
      "PATH_DENIED",
      "The path is unavailable or contains a symbolic link.",
    ),
  );
  await expect(readFile(join(f.workspace, "fresh.txt"))).rejects.toThrow();
  // ODDITY: binary targets report CONFLICT ("changed on disk"), not a type error.
  await writeFile(join(f.workspace, "bin.dat"), Buffer.from([0, 1, 2]));
  expect(
    await run("file.write", {
      ...ws,
      path: "bin.dat",
      content: "x",
      expectedRevision: "any",
    }),
  ).toEqual(
    rejected(
      "CONFLICT",
      "The file changed on disk. Reopen it before saving your edits.",
    ),
  );
  expect(
    await run("file.write", {
      ...ws,
      path: "ln",
      content: "x",
      expectedRevision: "any",
    }),
  ).toEqual(
    rejected(
      "PATH_DENIED",
      "The path is unavailable or contains a symbolic link.",
    ),
  );
  expect(await readFile(join(outside, "target.txt"), "utf8")).toBe("target\n");
  expect(
    await run("file.write", {
      workspaceId: randomUUID(),
      path: "hello.txt",
      content: "x",
      expectedRevision: current,
    }),
  ).toEqual(rejected("NOT_FOUND", "workspace was not found."));
  await writeFile(target, original);
});

it("attachment.workspace uploads workspace text as a session attachment and artifact.get reads it back", async () => {
  const f = fixture;
  const ws = { workspaceId: f.workspaceId };
  const text = "first line\nsecond line\n";
  const receipt = await run(
    "attachment.workspace",
    { ...ws, path: "hello.txt" },
    f.session.id,
  );
  expect(receipt.status).toBe("completed");
  expect(receipt.result).toEqual({
    id: expect.any(String),
    name: "hello.txt",
    mime: "text/plain",
    kind: "attachment",
    sessionId: f.session.id,
    bytes: 23,
    sha256: sha(text),
    contextPath: "hello.txt",
  });
  const id = receipt.result!.id;
  // contextPath is a receipt-only field; the stored asset lacks it.
  expect(f.host.store.get("asset", id)).toEqual({
    id,
    name: "hello.txt",
    mime: "text/plain",
    kind: "attachment",
    sessionId: f.session.id,
    bytes: 23,
    sha256: sha(text),
  });
  await mkdir(join(f.workspace, "deep"), { recursive: true });
  await writeFile(join(f.workspace, "deep", "a.txt"), "a");
  expect(
    (
      await run(
        "attachment.workspace",
        { ...ws, path: "deep/a.txt" },
        f.session.id,
      )
    ).result,
  ).toMatchObject({ name: "a.txt", bytes: 1, contextPath: "deep/a.txt" });

  expect(
    await run("attachment.workspace", { ...ws, path: "hello.txt" }),
  ).toEqual(rejected("VALIDATION", "Select a session."));
  expect(
    await run(
      "attachment.workspace",
      { workspaceId: randomUUID(), path: "hello.txt" },
      f.session.id,
    ),
  ).toEqual(
    rejected("PATH_DENIED", "Choose a file from the session workspace."),
  );
  expect(
    await run(
      "attachment.workspace",
      { ...ws, path: "hello.txt" },
      randomUUID(),
    ),
  ).toEqual(rejected("NOT_FOUND", "session was not found."));
  expect(
    await run("attachment.workspace", { ...ws, path: "../x" }, f.session.id),
  ).toEqual(rejected("PATH_DENIED", "Choose a path inside this workspace."));
  await writeFile(join(f.workspace, "bin.dat"), Buffer.from([0, 1, 2]));
  expect(
    await run("attachment.workspace", { ...ws, path: "bin.dat" }, f.session.id),
  ).toEqual(
    rejected(
      "LIMIT_EXCEEDED",
      "Context files must be UTF-8 text smaller than 1 MiB.",
    ),
  );

  // artifact.get
  const full = await run("artifact.get", { artifactId: id }, f.session.id);
  expect(full.result).toEqual({
    id,
    name: "hello.txt",
    mime: "text/plain",
    kind: "attachment",
    sessionId: f.session.id,
    bytes: 23,
    sha256: sha(text),
    data: Buffer.from(text).toString("base64"),
  });
  expect(
    (
      await run(
        "artifact.get",
        { artifactId: id, offset: 6, length: 4 },
        f.session.id,
      )
    ).result?.data,
  ).toBe(Buffer.from("line").toString("base64"));
  expect(
    (await run("artifact.get", { artifactId: id, offset: 100 }, f.session.id))
      .result?.data,
  ).toBe("");
  // An omitted session is rejected before any blob read.
  expect(await run("artifact.get", { artifactId: id })).toEqual(
    rejected("VALIDATION", "Select a session."),
  );
  const other = f.host.store.put("session", {
    id: randomUUID(),
    workspaceId: f.workspaceId,
    runtimeId: f.runtime.id,
    name: "other",
    revision: 1,
  });
  expect(await run("artifact.get", { artifactId: id }, other.id)).toEqual(
    rejected("PATH_DENIED", "Attachment belongs to another session."),
  );
  expect(
    await run("artifact.get", { artifactId: randomUUID() }, f.session.id),
  ).toEqual(rejected("NOT_FOUND", "asset was not found."));
  expect(await run("artifact.get", {})).toEqual(
    rejected("VALIDATION", "Invalid artifactId."),
  );
  // An asset record whose blob is missing is a bounded unavailable error.
  const ghost = f.host.store.put("asset", {
    id: randomUUID(),
    name: "ghost.png",
    mime: "image/png",
    kind: "attachment",
    sessionId: f.session.id,
    bytes: 3,
    sha256: "x",
  });
  expect(
    await run("artifact.get", { artifactId: ghost.id }, f.session.id),
  ).toEqual(
    rejected("ARTIFACT_UNAVAILABLE", "The attachment is no longer available."),
  );
  expect(await run("artifact.get", { artifactId: ghost.id }, other.id)).toEqual(
    rejected("PATH_DENIED", "Attachment belongs to another session."),
  );
});

it("artifact command requires a valid owning session", async () => {
  const f = fixture;
  const asset = f.host.store.put("asset", {
    id: randomUUID(),
    name: "own.txt",
    mime: "text/plain",
    kind: "attachment",
    sessionId: f.session.id,
    bytes: 3,
    sha256: "x",
  });
  await writeFile(join(f.host.store.root, "assets", asset.id), "own");
  const other = f.host.store.put("session", {
    id: randomUUID(),
    workspaceId: f.workspaceId,
    runtimeId: f.runtime.id,
    name: "other-owner",
    revision: 1,
  });
  const resources = vi.spyOn(Assets.prototype, "read");
  const missing = rejected("VALIDATION", "Select a session.");
  expect(await run("artifact.get", { artifactId: asset.id })).toEqual(missing);
  expect(await run("artifact.get", { artifactId: asset.id }, "")).toEqual(
    missing,
  );
  expect(
    await run("artifact.get", { artifactId: asset.id }, randomUUID()),
  ).toEqual(rejected("NOT_FOUND", "session was not found."));
  expect(await run("artifact.get", { artifactId: asset.id }, other.id)).toEqual(
    rejected("PATH_DENIED", "Attachment belongs to another session."),
  );
  // Denied calls never reached a blob read (only the cross-session lookup did).
  expect(resources).toHaveBeenCalledTimes(1);
  const owner = await run(
    "artifact.get",
    { artifactId: asset.id },
    f.session.id,
  );
  expect(owner.result).toMatchObject({
    id: asset.id,
    data: Buffer.from("own").toString("base64"),
  });
  resources.mockRestore();
});

it("workspace.list discovers worktrees and workspace.select registers them idempotently", async () => {
  const f = fixture;
  const repo = join(outside, "repo");
  await mkdir(repo);
  const git = (...args: string[]) =>
    execFileSync("/usr/bin/git", ["-C", repo, ...args], { stdio: "pipe" });
  git("init", "-b", "main");
  await writeFile(join(repo, "a.txt"), "a\n");
  git("add", "a.txt");
  git(
    "-c",
    "user.name=Suri fixture",
    "-c",
    "user.email=fixture@invalid",
    "commit",
    "-m",
    "fixture",
  );
  git("worktree", "add", "-b", "wt", join(outside, "second"));
  const project = { id: randomUUID(), root: repo, label: "repo", revision: 1 };
  const workspace = {
    id: randomUUID(),
    projectId: project.id,
    root: repo,
    label: "repo",
    revision: 1,
  };
  f.host.store.put("project", project);
  f.host.store.put("workspace", workspace);

  expect(
    (await run("git.status", { workspaceId: workspace.id })).result,
  ).toEqual({ text: "" });
  const listed = await run("workspace.list", { workspaceId: workspace.id });
  expect(listed.result).toEqual({
    candidates: [
      {
        candidateId: expect.any(String),
        root: repo,
        label: "refs/heads/main",
      },
      {
        candidateId: expect.any(String),
        root: join(outside, "second"),
        label: "refs/heads/wt",
      },
    ],
  });
  // Lookup by projectId reaches the same repo but mints fresh candidate ids.
  const byProject = await run("workspace.list", { projectId: project.id });
  expect(byProject.result?.candidates.map((c: any) => c.root)).toEqual([
    repo,
    join(outside, "second"),
  ]);
  expect(await run("workspace.list", { projectId: randomUUID() })).toEqual(
    rejected("NOT_FOUND", "Workspace not found."),
  );

  const [main, second] = listed.result!.candidates;
  const before = f.host.store.head("catalog");
  const selected = await run("workspace.select", {
    candidateId: second.candidateId,
    projectId: project.id,
  });
  expect(selected.result).toEqual({
    id: expect.any(String),
    projectId: project.id,
    root: join(outside, "second"),
    label: "refs/heads/wt",
    revision: 1,
  });
  expect(f.host.store.get("workspace", selected.result!.id)).toEqual(
    selected.result,
  );
  const afterNew = f.host.store.head("catalog");
  // Selecting the same candidate again returns the existing workspace.
  const again = await run("workspace.select", {
    candidateId: second.candidateId,
    projectId: project.id,
  });
  expect(again.result).toEqual(selected.result);
  expect(f.host.store.head("catalog")).toBe(afterNew);
  expect(f.host.store.get("workspace", selected.result!.id).revision).toBe(1);
  // A candidate whose root is already a workspace returns that record.
  const existing = await run("workspace.select", {
    candidateId: main.candidateId,
    projectId: project.id,
  });
  expect(existing.result).toEqual(workspace);
  expect(f.host.store.head("catalog")).toBe(afterNew);
  // Only the newly registered workspace is published; no-op selects are silent.
  const events = catalogSince(before);
  expect(events.map((e) => e.type)).toEqual(["catalog.workspace"]);
  expect(events.map((e) => e.payload.id)).toEqual([selected.result!.id]);
  expect(
    f.host.store.list("workspace").filter((w) => w.projectId === project.id),
  ).toHaveLength(2);

  const denied = rejected("PATH_DENIED", "Select a discovered worktree.");
  expect(
    await run("workspace.select", {
      candidateId: second.candidateId,
      projectId: randomUUID(),
    }),
  ).toEqual(denied);
  expect(
    await run("workspace.select", {
      candidateId: randomUUID(),
      projectId: project.id,
    }),
  ).toEqual(denied);
  expect(await run("workspace.select", { projectId: project.id })).toEqual(
    rejected("VALIDATION", "Invalid candidateId."),
  );
});

it("icon.set and icon.clear patch project or session by revision and publish catalog events", async () => {
  const f = fixture;
  const project = f.host.store.put("project", {
    id: randomUUID(),
    root: outside,
    label: "icons",
    revision: 1,
  });
  const icon = f.host.store.put("asset", {
    id: randomUUID(),
    name: "i.png",
    mime: "image/png",
    kind: "icon",
    sessionId: "",
    bytes: 3,
    sha256: "x",
  });
  const attachment = f.host.store.put("asset", {
    id: randomUUID(),
    name: "a.txt",
    mime: "text/plain",
    kind: "attachment",
    sessionId: f.session.id,
    bytes: 1,
    sha256: "x",
  });
  const before = f.host.store.head("catalog");

  const set = await run(
    "icon.set",
    { targetId: project.id, assetId: icon.id },
    undefined,
    1,
  );
  expect(set.result).toEqual({
    id: project.id,
    root: outside,
    label: "icons",
    revision: 2,
    iconId: icon.id,
    updatedAt: expect.any(String),
  });
  const conflict = rejected(
    "CONFLICT",
    "This item changed. Refresh and try again.",
  );
  expect(
    await run(
      "icon.set",
      { targetId: project.id, assetId: icon.id },
      undefined,
      1,
    ),
  ).toEqual(conflict);
  expect(
    await run(
      "icon.set",
      { targetId: project.id, assetId: attachment.id },
      undefined,
      2,
    ),
  ).toEqual(rejected("VALIDATION", "Select a decoded icon image."));
  expect(
    await run(
      "icon.set",
      { targetId: project.id, assetId: randomUUID() },
      undefined,
      2,
    ),
  ).toEqual(rejected("NOT_FOUND", "asset was not found."));
  // Non-project targets are treated as sessions.
  const session = await run(
    "icon.set",
    { targetId: f.session.id, assetId: icon.id },
    undefined,
    f.host.store.get("session", f.session.id).revision,
  );
  expect(session.result).toMatchObject({ id: f.session.id, iconId: icon.id });
  expect(
    await run(
      "icon.set",
      { targetId: randomUUID(), assetId: icon.id },
      undefined,
      1,
    ),
  ).toEqual(rejected("NOT_FOUND", "Icon target was not found."));

  const cleared = await run(
    "icon.clear",
    { targetId: project.id },
    undefined,
    2,
  );
  expect(cleared.result).toEqual({
    id: project.id,
    root: outside,
    label: "icons",
    revision: 3,
    iconId: null,
    updatedAt: expect.any(String),
  });
  expect(
    await run("icon.clear", { targetId: project.id }, undefined, 2),
  ).toEqual(conflict);
  // ODDITY: a missing expectedRevision is a CONFLICT, not VALIDATION.
  expect(await run("icon.clear", { targetId: project.id })).toEqual(conflict);
  expect(await run("icon.clear", {})).toEqual(
    rejected("VALIDATION", "Invalid targetId."),
  );
  const events = catalogSince(before);
  expect(events.map((e) => [e.type, e.payload.id, e.payload.iconId])).toEqual([
    ["catalog.project", project.id, icon.id],
    ["catalog.session", f.session.id, icon.id],
    ["catalog.project", project.id, null],
  ]);
});

it("icon mutations distinguish existing project and session targets from absent targets", async () => {
  const f = fixture;
  const notFound = rejected("NOT_FOUND", "Icon target was not found.");
  const icon = f.host.store.put("asset", {
    id: randomUUID(),
    name: "i2.png",
    mime: "image/png",
    kind: "icon",
    sessionId: "",
    bytes: 3,
    sha256: "x",
  });
  const project = f.host.store.put("project", {
    id: randomUUID(),
    root: join(outside, "icon-targets"),
    label: "icon-targets",
    revision: 1,
  });
  const doomedProject = f.host.store.put("project", {
    id: randomUUID(),
    root: join(outside, "doomed"),
    label: "doomed",
    revision: 1,
  });
  const doomedSession = f.host.store.put("session", {
    id: randomUUID(),
    workspaceId: f.workspaceId,
    runtimeId: f.runtime.id,
    name: "doomed",
    revision: 1,
  });
  f.host.store.remove("project", doomedProject.id);
  f.host.store.remove("session", doomedSession.id);
  const before = f.host.store.head("catalog");

  for (const [type, extra] of [
    ["icon.set", { assetId: icon.id }],
    ["icon.clear", {}],
  ] as const) {
    for (const target of [doomedProject.id, doomedSession.id, randomUUID()])
      expect(
        await run(type, { targetId: target, ...extra }, undefined, 1),
      ).toEqual(notFound);
    expect(await run(type, { ...extra }, undefined, 1)).toEqual(
      rejected("VALIDATION", "Invalid targetId."),
    );
  }
  expect(f.host.store.head("catalog")).toBe(before);
  expect(f.host.store.get("project", project.id).revision).toBe(1);

  const sessionRevision = f.host.store.get("session", f.session.id).revision;
  const setProject = await run(
    "icon.set",
    { targetId: project.id, assetId: icon.id },
    undefined,
    1,
  );
  expect(setProject.result).toMatchObject({ id: project.id, iconId: icon.id });
  const setSession = await run(
    "icon.set",
    { targetId: f.session.id, assetId: icon.id },
    undefined,
    sessionRevision,
  );
  expect(setSession.result).toMatchObject({
    id: f.session.id,
    iconId: icon.id,
  });
  expect(
    (await run("icon.clear", { targetId: project.id }, undefined, 2)).result,
  ).toMatchObject({ id: project.id, iconId: null });
  expect(
    (
      await run(
        "icon.clear",
        { targetId: f.session.id },
        undefined,
        sessionRevision + 1,
      )
    ).result,
  ).toMatchObject({ id: f.session.id, iconId: null });
  expect(catalogSince(before).map((e) => e.type)).toEqual([
    "catalog.project",
    "catalog.session",
    "catalog.project",
    "catalog.session",
  ]);
});

it("session.import with a candidate runtime fails and leaves no provisional session", async () => {
  const f = fixture;
  const path = join(outside, "cand.jsonl");
  await writeFile(path, history(f.workspace));
  const grantId = await fileGrant(path);
  const before = sessionIds();
  const dirsBefore = await runtimeDirs();
  const catalogBefore = f.host.store.head("catalog");
  const payload = {
    fileGrantId: grantId,
    workspaceId: f.workspaceId,
    runtimeId: f.runtime.id,
  };
  expect(await run("session.import", payload)).toEqual(
    rejected(
      "RUNTIME_UNSUPPORTED",
      "This runtime candidate requires real smoke validation.",
    ),
  );
  // The provisional row, its private directory and any child are rolled back;
  // no catalog.session is published for it.
  expect(sessionIds().filter((id) => !before.includes(id))).toHaveLength(0);
  expect(await runtimeDirs()).toEqual(dirsBefore);
  expect(catalogSince(catalogBefore).map((e) => e.type)).not.toContain(
    "catalog.session",
  );
  // The grant was consumed by the failed attempt.
  expect(await run("session.import", payload)).toEqual(
    rejected(
      "PATH_DENIED",
      "Select this resource through the local picker or CLI.",
    ),
  );
});

it("session.import copies a matching Pi history into a new started session and rejects invalid sources", async () => {
  const f = fixture;
  f.host.store.put("runtime", {
    ...f.host.store.get("runtime", f.runtime.id),
    status: "verified",
  });
  const piSessionId = randomUUID();
  const source = join(outside, "ok.jsonl");
  await writeFile(source, history(f.workspace, piSessionId));
  const payload = async (path = source) => ({
    fileGrantId: await fileGrant(path),
    workspaceId: f.workspaceId,
    runtimeId: f.runtime.id,
  });
  const before = sessionIds();
  const catalogBefore = f.host.store.head("catalog");
  const childrenBefore = f.host.children.size;

  const receipt = await run("session.import", await payload());
  expect(receipt.status).toBe("completed");
  const imported = receipt.result!;
  // The receipt is the pre-start record; the stored record also has
  // model/thinkingLevel but no processPid (the import closes its runtime).
  // The name comes from the history header ("Hist").
  expect(imported).toEqual({
    id: expect.any(String),
    workspaceId: f.workspaceId,
    runtimeId: f.runtime.id,
    name: "Hist",
    revision: 1,
    archived: false,
    piFile: join(f.data, "runtime", imported.id, "import.jsonl"),
    piSessionId,
  });
  expect(sessionIds().filter((id) => !before.includes(id))).toEqual([
    imported.id,
  ]);
  expect(f.host.store.get("session", imported.id)).toEqual({
    ...imported,
    model: { provider: "synthetic", id: "fixture-model" },
    thinkingLevel: "medium",
  });
  expect(await readFile(imported.piFile, "utf8")).toBe(
    await readFile(source, "utf8"),
  );
  expect(await readdir(join(f.data, "runtime", imported.id))).toContain(
    "import.jsonl",
  );
  expect(f.host.children.has(imported.id)).toBe(false);
  expect(f.host.store.get("session", imported.id).processPid).toBeUndefined();
  expect(f.host.store.snapshot(`session:${imported.id}`).phase).toBe("closed");
  expect(
    catalogSince(catalogBefore).map((e) => [
      e.type,
      e.payload.sessionId ?? e.payload.id,
    ]),
  ).toEqual([
    ["catalog.sessionPhase", imported.id],
    ["catalog.sessionPhase", imported.id],
    ["catalog.sessionPhase", imported.id],
    ["catalog.session", imported.id],
  ]);

  // Rejections.
  const mismatch = join(outside, "mm.jsonl");
  await writeFile(mismatch, history(outside));
  const bad = join(outside, "bad.jsonl");
  await writeFile(bad, "nope\n");
  const afterSuccess = sessionIds();
  const header = rejected(
    "PATH_DENIED",
    "Imported history must match the selected workspace.",
  );
  expect(await run("session.import", await payload(mismatch))).toEqual(header);
  // ODDITY: an unparsable history reports the workspace-mismatch message.
  expect(await run("session.import", await payload(bad))).toEqual(header);
  expect(
    await run("session.import", {
      ...(await payload()),
      workspaceId: randomUUID(),
    }),
  ).toEqual(rejected("NOT_FOUND", "workspace was not found."));
  const dirsBefore = await runtimeDirs();
  expect(
    await run("session.import", {
      ...(await payload()),
      runtimeId: randomUUID(),
    }),
  ).toEqual(rejected("NOT_FOUND", "runtime was not found."));
  expect(
    await run("session.import", {
      fileGrantId: (await payload()).fileGrantId,
      workspaceId: f.workspaceId,
    }),
  ).toEqual(rejected("VALIDATION", "Invalid runtimeId."));
  expect(await runtimeDirs()).toEqual(dirsBefore);
  expect(f.host.children.size).toBe(childrenBefore);
  const denied = rejected(
    "PATH_DENIED",
    "Select this resource through the local picker or CLI.",
  );
  expect(
    await run("session.import", {
      ...(await payload()),
      fileGrantId: (
        await control(f.data, {
          type: "grant",
          kind: "directory",
          path: outside,
        })
      ).grantId,
    }),
  ).toEqual(denied);
  expect(
    await run("session.import", {
      ...(await payload()),
      fileGrantId: randomUUID(),
    }),
  ).toEqual(denied);
  expect(await run("session.import", {})).toEqual(
    rejected("VALIDATION", "Invalid fileGrantId."),
  );
  expect(sessionIds()).toEqual(afterSuccess);
});

const verifiedRuntime = () =>
  fixture.host.store.put("runtime", {
    ...fixture.host.store.get("runtime", fixture.runtime.id),
    status: "verified",
  });

it("failed import after child allocation rolls back only its provisional session", async () => {
  const f = fixture;
  verifiedRuntime();
  // A runtime that answers --version but exits as soon as it is spawned for RPC.
  const dead = join(outside, "dead-pi");
  await mkdir(join(dead, "dist"), { recursive: true });
  await writeFile(
    join(dead, "package.json"),
    JSON.stringify({ name: "dead-pi", version: "0.85.1", type: "module" }),
  );
  const exe = join(dead, "dist/cli.mjs");
  await writeFile(
    exe,
    '#!/usr/bin/env node\nif (process.argv.includes("--version")) console.log("0.85.1");\nprocess.exit(process.argv.includes("--version") ? 0 : 3);\n',
    { mode: 0o755 },
  );
  const registered = await run("runtime.register", {
    executableGrantId: (
      await control(f.data, { type: "grant", kind: "executable", path: exe })
    ).grantId,
    expectedVersion: "0.85.1",
  });
  expect(registered.status).toBe("completed");
  f.host.store.put("runtime", {
    ...f.host.store.get("runtime", registered.result!.id),
    status: "verified",
  });
  const sentinel = f.host.store.put("session", {
    id: randomUUID(),
    workspaceId: f.workspaceId,
    runtimeId: f.runtime.id,
    name: "sentinel",
    revision: 1,
    archived: false,
  });
  await mkdir(join(f.data, "runtime", sentinel.id), { recursive: true });
  const path = join(outside, "rollback.jsonl");
  await writeFile(path, history(f.workspace));
  const before = sessionIds();
  const dirsBefore = await runtimeDirs();
  const childrenBefore = f.host.children.size;
  const catalogBefore = f.host.store.head("catalog");
  const receipt = await run("session.import", {
    fileGrantId: await fileGrant(path),
    workspaceId: f.workspaceId,
    runtimeId: registered.result!.id,
  });
  expect(receipt.status).toBe("rejected");
  expect(sessionIds()).toEqual(before);
  expect(await runtimeDirs()).toEqual(dirsBefore);
  expect(f.host.children.size).toBe(childrenBefore);
  expect(f.host.store.get("session", sentinel.id).name).toBe("sentinel");
  expect(catalogSince(catalogBefore).map((e) => e.type)).not.toContain(
    "catalog.session",
  );
  expect(f.host.store.get("session", sentinel.id).processPid).toBeUndefined();
});

it("single and batch imports release only their own runtime", async () => {
  const f = fixture;
  verifiedRuntime();
  await run("session.resume", {}, f.session.id);
  for (let i = 0; i < 100 && !f.host.children.has(f.session.id); i++)
    await new Promise((r) => setTimeout(r, 50));
  expect(f.host.children.has(f.session.id)).toBe(true);
  const pid = f.host.children.get(f.session.id)!.child.pid;
  const single = join(outside, "own-single.jsonl");
  const batch = join(outside, "own-batch.jsonl");
  await writeFile(single, history(f.workspace));
  await writeFile(batch, history(f.workspace));
  const one = await run("session.import", {
    fileGrantId: await fileGrant(single),
    workspaceId: f.workspaceId,
    runtimeId: f.runtime.id,
  });
  const many = await run("session.importBatch", {
    fileGrantIds: [await fileGrant(batch)],
    workspaceId: f.workspaceId,
    runtimeId: f.runtime.id,
  });
  expect(one.status).toBe("completed");
  expect(many.status).toBe("completed");
  const batchId = many.result!.imported[0].sessionId;
  for (const id of [one.result!.id, batchId]) {
    expect(f.host.children.has(id)).toBe(false);
    expect(f.host.store.get("session", id).processPid).toBeUndefined();
  }
  expect(f.host.children.get(f.session.id)!.child.pid).toBe(pid);
  expect(f.host.children.get(f.session.id)!.child.exitCode).toBeNull();
  expect(f.host.store.get("session", f.session.id).processPid).toBe(pid);
});

it("single import uses a bounded header name or Imported session fallback", async () => {
  const f = fixture;
  verifiedRuntime();
  const importWith = async (name: unknown, file: string, raw?: string) => {
    const path = join(outside, file);
    await writeFile(
      path,
      raw ??
        JSON.stringify({
          type: "session",
          version: 3,
          id: randomUUID(),
          cwd: f.workspace,
          ...(name === undefined ? {} : { name }),
        }) + "\n",
    );
    return run("session.import", {
      fileGrantId: await fileGrant(path),
      workspaceId: f.workspaceId,
      runtimeId: f.runtime.id,
    });
  };
  const named = async (name: unknown, file: string) => {
    const receipt = await importWith(name, file);
    expect(receipt.status).toBe("completed");
    const stored = f.host.store.get("session", receipt.result!.id);
    expect(stored.name).toBe(receipt.result!.name);
    return receipt.result!.name;
  };
  expect(await named(undefined, "n0.jsonl")).toBe("Imported session");
  expect(await named("   ", "n1.jsonl")).toBe("Imported session");
  expect(await named(42, "n2.jsonl")).toBe("Imported session");
  expect(await named("  Padded  ", "n3.jsonl")).toBe("Padded");
  expect(await named("x".repeat(300), "n4.jsonl")).toBe("x".repeat(200));
  const before = sessionIds();
  expect(await importWith(undefined, "n5.jsonl", "{not json\n")).toEqual(
    rejected(
      "PATH_DENIED",
      "Imported history must match the selected workspace.",
    ),
  );
  expect(sessionIds()).toEqual(before);
});

it("single import retires an EOF-resistant child before forgetting it", async () => {
  const f = fixture;
  verifiedRuntime();
  // Initializes normally, then ignores stdin EOF and SIGTERM.
  const stubborn = join(outside, "stubborn-pi");
  await mkdir(join(stubborn, "dist"), { recursive: true });
  await writeFile(
    join(stubborn, "package.json"),
    JSON.stringify({ name: "stubborn-pi", version: "0.85.1", type: "module" }),
  );
  const exe = join(stubborn, "dist/cli.mjs");
  const fake = await readFile("tests/fixtures/fake-pi.mjs", "utf8");
  await writeFile(
    exe,
    fake.replace(
      /^(#![^\n]*\n)?/,
      (shebang) =>
        `${shebang}if (!process.argv.includes("--version")) { process.on("SIGTERM", () => {}); setInterval(() => {}, 1000); }\n`,
    ),
    { mode: 0o755 },
  );
  const registered = await run("runtime.register", {
    executableGrantId: (
      await control(f.data, { type: "grant", kind: "executable", path: exe })
    ).grantId,
    expectedVersion: "0.85.1",
  });
  expect(registered.status).toBe("completed");
  f.host.store.put("runtime", {
    ...f.host.store.get("runtime", registered.result!.id),
    status: "verified",
  });
  const path = join(outside, "stubborn.jsonl");
  await writeFile(path, history(f.workspace));
  const before = sessionIds();
  const dirsBefore = await runtimeDirs();
  const childrenBefore = f.host.children.size;
  const catalogBefore = f.host.store.head("catalog");
  const pids: number[] = [];
  const spy = f.host.children.set.bind(f.host.children);
  f.host.children.set = (id, client) => {
    if (client.child.pid) {
      pids.push(client.child.pid);
      stubbornPids.push(client.child.pid);
    }
    return spy(id, client);
  };
  let receipt;
  try {
    receipt = await run("session.import", {
      fileGrantId: await fileGrant(path),
      workspaceId: f.workspaceId,
      runtimeId: registered.result!.id,
    });
  } finally {
    f.host.children.set = spy;
  }
  expect(receipt.status).toBe("rejected");
  expect(receipt.error?.code).toBe("RUNTIME_EXIT_TIMEOUT");
  expect(pids).toHaveLength(1);
  expect(() => process.kill(pids[0], 0)).toThrow();
  expect(sessionIds()).toEqual(before);
  expect(await runtimeDirs()).toEqual(dirsBefore);
  expect(f.host.children.size).toBe(childrenBefore);
  expect(catalogSince(catalogBefore).map((e) => e.type)).not.toContain(
    "catalog.session",
  );
}, 30_000);

const importFailureState = async (path: string) => ({
  rows: sessionIds(),
  dirs: await runtimeDirs(),
  children: fixture.host.children.size,
  source: await readFile(path, "utf8"),
});
const importFrom = async (path: string, runtimeId = fixture.runtime.id) =>
  run("session.import", {
    fileGrantId: await fileGrant(path),
    workspaceId: fixture.workspaceId,
    runtimeId,
  });

it("import failing at initial persistence removes its private directory", async () => {
  const f = fixture;
  verifiedRuntime();
  const path = join(outside, "persist-fail.jsonl");
  await writeFile(path, history(f.workspace));
  const before = await importFailureState(path);
  const put = f.host.store.put.bind(f.host.store);
  f.host.store.put = ((kind: string, item: any) => {
    if (kind === "session" && String(item.piFile).endsWith("import.jsonl"))
      throw new Error("disk exploded at /secret/path");
    return put(kind, item);
  }) as typeof f.host.store.put;
  let receipt;
  try {
    receipt = await importFrom(path);
  } finally {
    f.host.store.put = put;
  }
  expect(receipt.status).toBe("rejected");
  expect(receipt.error?.code).toBe("INTERNAL");
  expect(JSON.stringify(receipt)).not.toContain("/secret/path");
  expect(await importFailureState(path)).toEqual(before);
});

it("import failing at copyFile removes its private directory", async () => {
  const f = fixture;
  verifiedRuntime();
  const path = join(outside, "copy-fail.jsonl");
  await writeFile(path, history(f.workspace));
  const before = await importFailureState(path);
  const get = f.host.store.get.bind(f.host.store);
  // Reading the workspace root happens after the source was read; delete the
  // source then so copyFile fails with ENOENT.
  f.host.store.get = ((kind: string, id: string) => {
    const item = get(kind, id);
    if (kind !== "workspace") return item;
    return Object.defineProperty({ ...item }, "root", {
      enumerable: true,
      get() {
        rmSync(path, { force: true });
        return item.root;
      },
    });
  }) as typeof f.host.store.get;
  let receipt;
  try {
    receipt = await importFrom(path);
  } finally {
    f.host.store.get = get;
  }
  expect(receipt.status).toBe("rejected");
  expect(receipt.error?.code).toBe("INTERNAL");
  expect(sessionIds()).toEqual(before.rows);
  expect(await runtimeDirs()).toEqual(before.dirs);
  expect(f.host.children.size).toBe(before.children);
});

it("import whose retirement throws keeps ownership until the child exits", async () => {
  const f = fixture;
  verifiedRuntime();
  const stubborn = join(outside, "stubborn-deferred-pi");
  await mkdir(join(stubborn, "dist"), { recursive: true });
  await writeFile(
    join(stubborn, "package.json"),
    JSON.stringify({ name: "stubborn-pi", version: "0.85.1", type: "module" }),
  );
  const exe = join(stubborn, "dist/cli.mjs");
  const fake = await readFile("tests/fixtures/fake-pi.mjs", "utf8");
  await writeFile(
    exe,
    fake.replace(
      /^(#![^\n]*\n)?/,
      (shebang) =>
        `${shebang}if (!process.argv.includes("--version")) { process.on("SIGTERM", () => {}); setInterval(() => {}, 1000); }\n`,
    ),
    { mode: 0o755 },
  );
  const registered = await run("runtime.register", {
    executableGrantId: (
      await control(f.data, { type: "grant", kind: "executable", path: exe })
    ).grantId,
    expectedVersion: "0.85.1",
  });
  expect(registered.status).toBe("completed");
  f.host.store.put("runtime", {
    ...f.host.store.get("runtime", registered.result!.id),
    status: "verified",
  });
  const path = join(outside, "deferred.jsonl");
  await writeFile(path, history(f.workspace));
  const before = await importFailureState(path);
  let captured: { id: string; client: any } | undefined;
  const spy = f.host.children.set.bind(f.host.children);
  f.host.children.set = (id, client) => {
    captured = { id, client };
    if (client.child.pid) stubbornPids.push(client.child.pid);
    // Simulates a failed SIGKILL (for example EPERM) during retirement.
    client.retireFailedStartup = async () => {
      throw new Error("EPERM");
    };
    return spy(id, client);
  };
  let receipt;
  try {
    receipt = await importFrom(path, registered.result!.id);
  } finally {
    f.host.children.set = spy;
  }
  expect(receipt.status).toBe("rejected");
  expect(receipt.error?.code).toBe("RUNTIME_EXIT_TIMEOUT");
  const { id, client } = captured!;
  const pid = client.child.pid as number;
  try {
    expect(() => process.kill(pid, 0)).not.toThrow();
    expect(sessionIds()).toContain(id);
    expect(f.host.children.get(id)).toBe(client);
    expect(await runtimeDirs()).toContain(id);
  } finally {
    process.kill(pid, "SIGKILL");
  }
  await client.exited;
  await vi.waitFor(async () => {
    expect(sessionIds()).toEqual(before.rows);
    expect(await runtimeDirs()).toEqual(before.dirs);
    expect(f.host.children.size).toBe(before.children);
  });
  expect(f.host.children.has(id)).toBe(false);
  expect(await readFile(path, "utf8")).toBe(before.source);
}, 30_000);
