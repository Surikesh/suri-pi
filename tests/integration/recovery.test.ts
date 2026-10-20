import { it, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { startHost } from "../../apps/host/src/host.js";
import { control } from "../../apps/host/src/cli.js";
it("preserves local UI association across host restart and rejects stale draft writes", async () => {
  const root = await mkdtemp(join(tmpdir(), "suri-recovery-"));
  const options = {
    root,
    assets: resolve("dist/ui"),
    helper: resolve("dist/native/suri-helper"),
  };
  let host = await startHost(options);
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
    host.store.put("project", project);
    host.store.put("workspace", workspace);
    host.store.put("runtime", runtime);
    const session = {
      id: randomUUID(),
      workspaceId: workspace.id,
      runtimeId: runtime.id,
      name: "fixture",
      revision: 1,
    };
    host.store.put("session", session);
    const save = {
      v: 1 as const,
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      type: "draft.save",
      sessionId: session.id,
      expectedRevision: 0,
      payload: { text: "preserve me", attachmentIds: [] },
    };
    const first = await host.execute(save, "native-client");
    expect(first.status).toBe("completed");
    expect(await host.execute(save, "native-client")).toEqual(first);
    await expect(
      host.execute(
        { ...save, payload: { ...save.payload, text: "changed" } },
        "native-client",
      ),
    ).rejects.toThrow("Request id was reused");
    const stale = await host.execute(
      { ...save, id: randomUUID() },
      "native-client",
    );
    expect(stale.status).toBe("rejected");
    expect(host.store.get("draft", `${session.id}:native-client`).text).toBe(
      "preserve me",
    );
    await control(root, { type: "associate-ui", path: resolve(".") });
    await host.close();
    host = await startHost(options);
    const receipt = await host.execute(
      {
        v: 1,
        id: randomUUID(),
        createdAt: new Date().toISOString(),
        type: "ui.builds",
        payload: {},
      },
      "native-client",
    );
    expect(receipt.status).toBe("completed");
    expect(receipt.result).toHaveProperty("ready");
    expect(
      host.store.get("draft", `${session.id}:native-client`).revision,
    ).toBe(1);
  } finally {
    await host.close();
    await rm(root, { recursive: true, force: true });
  }
});
