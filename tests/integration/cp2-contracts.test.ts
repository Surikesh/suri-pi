// CP2 preserved contracts (CP2-design.md R03, R07, R11, R12, R15). These rows
// keep current product behaviour; the tests lock it without product changes.
// R27 lives in host-concurrent-renewal.test.ts. No sleeps: held promises and
// direct awaits only.
import { afterAll, beforeAll, expect, it } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { browserHost } from "../support/browser-host.js";
import { control } from "../../apps/host/src/cli.js";
import { startHost } from "../../apps/host/src/host.js";
import { Storage } from "../../apps/host/src/storage.js";

let fixture: Awaited<ReturnType<typeof browserHost>>;
let outside: string;
beforeAll(async () => {
  fixture = await browserHost(undefined, undefined, false);
  outside = await mkdtemp(join(tmpdir(), "suri-cp2-out-"));
});
afterAll(async () => {
  await fixture?.close();
  if (outside) await rm(outside, { recursive: true, force: true });
});

const envelope = (
  type: string,
  payload: Record<string, unknown> = {},
  expectedRevision?: number,
) => ({
  v: 1 as const,
  id: randomUUID(),
  createdAt: new Date().toISOString(),
  type,
  payload,
  expectedRevision,
});
const run = (
  type: string,
  payload: Record<string, unknown> = {},
  expectedRevision?: number,
) => fixture.host.execute(envelope(type, payload, expectedRevision), "cp2");
const sha = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
const rejection = (code: string, message: string) => ({
  v: 1,
  id: expect.any(String),
  status: "rejected",
  error: { code, message, retryable: false },
});
const CONFLICT = rejection(
  "CONFLICT",
  "The file changed on disk. Reopen it before saving your edits.",
);
const UNAVAILABLE = rejection(
  "PATH_DENIED",
  "The path is unavailable or contains a symbolic link.",
);

// R03
it("identical runtime validation polls start exactly one job", async () => {
  const root = await mkdtemp(join(tmpdir(), "suri-cp2-validate-"));
  const runtimeId = randomUUID();
  const seed = new Storage(root);
  seed.put("runtime", {
    id: runtimeId,
    version: "fixture",
    executable: "/fixture",
    identity: "fixture",
    status: "candidate",
    revision: 1,
  });
  seed.close();
  let started = 0;
  let release!: () => void;
  const gate = new Promise<void>((done) => (release = done));
  const promoted = {
    id: runtimeId,
    version: "fixture",
    executable: "/fixture",
    identity: "fixture",
    status: "verified",
    evidenceId: "fixture-evidence",
    validatedAt: "2026-01-01T00:00:00.000Z",
    revision: 2,
  };
  const host = await startHost({
    root,
    assets: resolve("dist/ui"),
    helper: resolve("dist/native/suri-helper"),
    validation: true,
    runtimeValidator: {
      validateAndPromote: async () => {
        started += 1;
        await gate;
        return promoted;
      },
    } as never,
  });
  try {
    const { grantId } = await control(root, {
      type: "runtime-validation-grant",
      provider: "fixture",
      model: "fixture",
      agentDir: "/tmp",
      confirmProviderSpend: true,
    });
    const command = envelope("runtime.validate", {
      runtimeId,
      validationGrantId: grantId,
    });
    const accepted = { v: 1, id: command.id, status: "accepted" };
    expect(await host.execute(command, "cp2")).toEqual(accepted);
    // Identical bytes while pending: same accepted receipt, grant not reused.
    for (let poll = 0; poll < 3; poll++)
      expect(await host.execute(command, "cp2")).toEqual(accepted);
    release();
    let terminal = await host.execute(command, "cp2");
    while (terminal.status === "accepted") {
      await new Promise((done) => setImmediate(done));
      terminal = await host.execute(command, "cp2");
    }
    expect(terminal).toEqual({
      v: 1,
      id: command.id,
      status: "completed",
      result: {
        runtimeId,
        status: "verified",
        identity: "fixture",
        evidenceId: "fixture-evidence",
        validatedAt: "2026-01-01T00:00:00.000Z",
      },
    });
    expect(await host.execute(command, "cp2")).toEqual(terminal);
    expect(started).toBe(1);
  } finally {
    release();
    await host.close();
    await rm(root, { recursive: true, force: true });
  }
});

// R07
const history = (cwd: string, extra = "") =>
  JSON.stringify({
    type: "session",
    version: 3,
    id: randomUUID(),
    cwd,
    name: "Hist",
  }) +
  "\n" +
  extra;
async function importPayload(path: string) {
  const f = fixture;
  f.host.store.put("runtime", {
    ...f.host.store.get("runtime", f.runtime.id),
    status: "verified",
  });
  return {
    fileGrantId: (await control(f.data, { type: "grant", kind: "file", path }))
      .grantId,
    workspaceId: f.workspaceId,
    runtimeId: f.runtime.id,
  };
}
const sessionIds = () => fixture.host.store.list("session").map((s) => s.id);
const importDirs = () => {
  try {
    return readdirSync(join(fixture.data, "runtime"));
  } catch {
    return [];
  }
};

it("unreadable import history is denied without filesystem details", async () => {
  const bad = join(outside, "garbage.jsonl");
  const stray = join(outside, "stray.jsonl");
  await writeFile(bad, "not a history\n");
  await writeFile(stray, history(join(outside, "does-not-exist")));
  const sessions = sessionIds();
  const dirs = importDirs();
  const catalog = fixture.host.store.head("catalog");
  for (const path of [bad, stray]) {
    const receipt = await run("session.import", await importPayload(path));
    expect(receipt).toEqual(
      rejection(
        "PATH_DENIED",
        "Imported history must match the selected workspace.",
      ),
    );
    expect(JSON.stringify(receipt)).not.toMatch(
      /ENOENT|EACCES|does-not-exist|garbage|stray|\/tmp|\/var/,
    );
  }
  expect(sessionIds()).toEqual(sessions);
  expect(importDirs()).toEqual(dirs);
  expect(fixture.host.store.head("catalog")).toBe(catalog);
});

it("OS-denied history reads retain the bounded generic error", async () => {
  if (process.getuid?.() === 0) return; // root ignores file modes
  const locked = join(outside, "locked.jsonl");
  await writeFile(locked, history(fixture.workspace));
  const payload = await importPayload(locked);
  const sessions = sessionIds();
  await chmod(locked, 0o000);
  try {
    const receipt = await run("session.import", payload);
    expect(receipt.status).toBe("rejected");
    expect(receipt.error?.code).toBe("INTERNAL");
    expect(receipt.error?.code).not.toBe("PATH_DENIED");
    expect(JSON.stringify(receipt)).not.toMatch(/EACCES|locked|\/tmp|\/var/);
  } finally {
    await chmod(locked, 0o600);
  }
  expect(sessionIds()).toEqual(sessions);
});

// R11
const workspaceFile = (name: string) => join(fixture.workspace, name);
const revisionOf = async (name: string) =>
  (await run("file.read", { workspaceId: fixture.workspaceId, path: name }))
    .result?.revision;
const write = (name: string, content: string, expectedRevision: unknown) =>
  run("file.write", {
    workspaceId: fixture.workspaceId,
    path: name,
    content,
    expectedRevision,
  });

it("file writes update existing text and never create or follow symlinks", async () => {
  const name = "r11.txt";
  await writeFile(workspaceFile(name), "one\n");
  const first = await revisionOf(name);
  expect(first).toBe(sha("one\n"));
  const updated = await write(name, "two\n", first);
  expect(updated.status).toBe("completed");
  expect(updated.result?.revision).toBe(sha("two\n"));
  expect(await readFile(workspaceFile(name), "utf8")).toBe("two\n");
  expect(await revisionOf(name)).toBe(sha("two\n"));

  // A missing target is never created.
  expect(await write("r11-new.txt", "x", sha(""))).toEqual(UNAVAILABLE);
  expect(readdirSync(fixture.workspace)).not.toContain("r11-new.txt");

  // A symlink target is never followed, even with the target's real revision.
  await writeFile(join(outside, "r11-target.txt"), "target\n");
  await symlink(join(outside, "r11-target.txt"), workspaceFile("r11-link"));
  expect(await write("r11-link", "x", sha("target\n"))).toEqual(UNAVAILABLE);
  expect(await readFile(join(outside, "r11-target.txt"), "utf8")).toBe(
    "target\n",
  );
  // A symlinked path component is also refused.
  await symlink(outside, workspaceFile("r11-dir"));
  expect(await write("r11-dir/r11-target.txt", "x", sha("target\n"))).toEqual(
    UNAVAILABLE,
  );
  expect(await readFile(join(outside, "r11-target.txt"), "utf8")).toBe(
    "target\n",
  );
  expect(await readFile(workspaceFile(name), "utf8")).toBe("two\n");
});

// R12
it("binary targets reject text writes without mutation", async () => {
  const bytes = Buffer.from([0, 1, 2, 255, 254]);
  await writeFile(workspaceFile("r12.bin"), bytes);
  const read = (await run("file.read", {
    workspaceId: fixture.workspaceId,
    path: "r12.bin",
  })) as { result?: { encoding: string; revision: string } };
  const current = read.result!;
  expect(current.encoding).not.toBe("utf8");
  const head = fixture.host.store.head("catalog");
  const stat = async () => ({
    bytes: await readFile(workspaceFile("r12.bin")),
    names: readdirSync(fixture.workspace).sort(),
  });
  const before = await stat();
  for (const revision of [current.revision, sha(bytes), sha("stale"), "any"]) {
    expect(await write("r12.bin", "text", revision)).toEqual(CONFLICT);
    const after = await stat();
    expect(sha(after.bytes)).toBe(sha(before.bytes));
    expect(after.names).toEqual(before.names);
  }
  expect(fixture.host.store.head("catalog")).toBe(head);
});

// R15
it("icon clear requires the current revision for project and session", async () => {
  const f = fixture;
  const icon = f.host.store.put("asset", {
    id: randomUUID(),
    name: "i.png",
    mime: "image/png",
    kind: "icon",
    sessionId: "",
    bytes: 3,
    sha256: "x",
  });
  const project = f.host.store.put("project", {
    id: randomUUID(),
    root: outside,
    label: "r15",
    revision: 1,
  });
  const targets = [
    { table: "project" as const, id: project.id as string },
    { table: "session" as const, id: f.session.id as string },
  ];
  for (const { table, id } of targets) {
    const set = await run(
      "icon.set",
      { targetId: id, assetId: icon.id },
      f.host.store.get(table, id).revision as number,
    );
    expect(set.status).toBe("completed");
    const revision = f.host.store.get(table, id).revision as number;
    const head = f.host.store.head("catalog");
    const conflict = rejection(
      "CONFLICT",
      "This item changed. Refresh and try again.",
    );
    expect(await run("icon.clear", { targetId: id })).toEqual(conflict);
    expect(await run("icon.clear", { targetId: id }, revision - 1)).toEqual(
      conflict,
    );
    expect(await run("icon.clear", { targetId: id }, revision + 1)).toEqual(
      conflict,
    );
    expect(f.host.store.get(table, id)).toMatchObject({
      revision,
      iconId: icon.id,
    });
    expect(f.host.store.head("catalog")).toBe(head);

    const cleared = await run("icon.clear", { targetId: id }, revision);
    expect(cleared.status).toBe("completed");
    expect(f.host.store.get(table, id)).toMatchObject({
      revision: revision + 1,
      iconId: null,
    });
    expect(f.host.store.head("catalog")).toBe(head + 1);
    // The same (now stale) revision cannot clear twice.
    expect(await run("icon.clear", { targetId: id }, revision)).toEqual(
      conflict,
    );
    expect(f.host.store.head("catalog")).toBe(head + 1);
  }
});
