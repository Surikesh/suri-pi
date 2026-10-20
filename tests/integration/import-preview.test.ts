import { expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { startHost } from "../../apps/host/src/host.js";
import { control } from "../../apps/host/src/cli.js";

it("previews import outcomes and keeps repeated duplicate imports idempotent", async () => {
  const root = await mkdtemp(join(tmpdir(), "suri-import-preview-"));
  const other = await mkdtemp(join(tmpdir(), "suri-import-other-"));
  const host = await startHost({
    root,
    assets: resolve("dist/ui"),
    helper: resolve("dist/native/suri-helper"),
  });
  try {
    const project = { id: randomUUID(), root, label: "fixture", revision: 1 };
    const workspace = {
      id: randomUUID(),
      projectId: project.id,
      root,
      label: "fixture",
      revision: 1,
    };
    const runtime = {
      id: randomUUID(),
      version: "fixture",
      executable: "/fixture",
      identity: "fixture",
      status: "candidate",
      revision: 1,
    };
    const duplicateId = randomUUID();
    host.store.put("project", project);
    host.store.put("workspace", workspace);
    host.store.put("runtime", runtime);
    host.store.put("session", {
      id: randomUUID(),
      workspaceId: workspace.id,
      runtimeId: runtime.id,
      piSessionId: duplicateId,
      name: "existing",
      revision: 1,
    });
    const files = {
      ready: join(root, "ready.jsonl"),
      duplicate: join(root, "duplicate.jsonl"),
      mismatch: join(root, "mismatch.jsonl"),
      invalid: join(root, "invalid.jsonl"),
    };
    await writeFile(
      files.ready,
      JSON.stringify({
        type: "session",
        version: 3,
        id: randomUUID(),
        cwd: root,
        name: "Ready history",
      }) + "\n",
    );
    await writeFile(
      files.duplicate,
      JSON.stringify({
        type: "session",
        version: 3,
        id: duplicateId,
        cwd: root,
      }) + "\n",
    );
    await writeFile(
      files.mismatch,
      JSON.stringify({
        type: "session",
        version: 3,
        id: randomUUID(),
        cwd: other,
      }) + "\n",
    );
    await writeFile(files.invalid, "not-json\n");
    const grants = await Promise.all(
      Object.values(files).map((path) =>
        control(root, { type: "grant", kind: "file", path }),
      ),
    );
    const envelope = (type: string, payload: Record<string, unknown>) => ({
      v: 1 as const,
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      type,
      payload,
    });
    const preview = await host.execute(
      envelope("session.importPreview", {
        workspaceId: workspace.id,
        fileGrantIds: grants.map((grant) => grant.grantId),
      }),
      "fixture-client",
    );
    expect(preview.status).toBe("completed");
    expect(preview.result?.candidates.map((item: any) => item.status)).toEqual([
      "ready",
      "duplicate",
      "path-mismatch",
      "incompatible",
    ]);
    expect(preview.result?.candidates[3]).toMatchObject({
      status: "incompatible",
      reason: "This file is not a compatible Pi history.",
    });
    expect(JSON.stringify(preview.result)).not.toContain("Unexpected");
    const original = await readFile(files.duplicate, "utf8");
    const before = host.store.list("session").length;
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await host.execute(
        envelope("session.importBatch", {
          workspaceId: workspace.id,
          runtimeId: runtime.id,
          fileGrantIds: [grants[1].grantId],
        }),
        "fixture-client",
      );
      expect(result.status).toBe("completed");
      expect(result.result?.skipped[0].status).toBe("duplicate");
    }
    expect(host.store.list("session")).toHaveLength(before);
    expect(await readFile(files.duplicate, "utf8")).toBe(original);
  } finally {
    await host.close();
    await Promise.all([
      rm(root, { recursive: true, force: true }),
      rm(other, { recursive: true, force: true }),
    ]);
  }
});
