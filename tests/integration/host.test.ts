import { it, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { createConnection } from "node:net";
import { once } from "node:events";
import { startHost } from "../../apps/host/src/host.js";
import { control } from "../../apps/host/src/cli.js";
it("shutdown closes an unfinished browser HTTP connection", async () => {
  const root = await mkdtemp(join(tmpdir(), "suri-host-close-"));
  const host = await startHost({
    root,
    assets: resolve("dist/ui"),
    helper: resolve("dist/native/suri-helper"),
  });
  const socket = createConnection(
    Number(new URL(host.origin).port),
    "127.0.0.1",
  );
  const connectionErrors: string[] = [];
  socket.on("error", (error: NodeJS.ErrnoException) => {
    connectionErrors.push(error.code ?? "UNKNOWN");
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await once(socket, "connect");
    socket.write("GET / HTTP/1.1\r\nHost: localhost\r\n");
    await Promise.race([
      host.close(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(Error("Host shutdown stalled")), 1000);
      }),
    ]);
    const restarted = await startHost({
      root,
      assets: resolve("dist/ui"),
      helper: resolve("dist/native/suri-helper"),
    });
    await restarted.close();
    expect(connectionErrors.every((code) => code === "ECONNRESET")).toBe(true);
  } finally {
    clearTimeout(timer);
    socket.destroy();
    await host.close();
    await rm(root, { recursive: true, force: true });
  }
});
it("closes admission during drain and retains lifecycle identity until teardown", async () => {
  const root = await mkdtemp(join(tmpdir(), "suri-host-stopping-"));
  const host = await startHost({
    root,
    assets: resolve("dist/ui"),
    helper: resolve("dist/native/suri-helper"),
  });
  const socket = createConnection(
    Number(new URL(host.origin).port),
    "127.0.0.1",
  );
  socket.on("error", () => {});
  try {
    await once(socket, "connect");
    socket.write("GET / HTTP/1.1\r\nHost: localhost\r\n");
    const closing = host.close();
    const late = await host.execute(
      {
        v: 1,
        id: randomUUID(),
        createdAt: new Date().toISOString(),
        type: "project.add",
        payload: {},
      },
      randomUUID(),
    );
    expect(late).toMatchObject({
      status: "rejected",
      error: { code: "HOST_STOPPING" },
    });
    const health = await control(root, { type: "health" });
    expect(health).toMatchObject({
      lifecycle: "stopping",
      shutdownStage: expect.stringMatching(
        /^(http|drain|children|storage|lock|control)$/,
      ),
    });
    socket.destroy();
    await closing;
    await expect(control(root, { type: "health" })).rejects.toMatchObject({
      detail: { code: "CONTROL_UNAVAILABLE" },
    });
  } finally {
    socket.destroy();
    await host.close();
    await rm(root, { recursive: true, force: true });
  }
});

it("counts live terminals as active work and drains their exit before storage", async () => {
  const root = await mkdtemp(join(tmpdir(), "suri-host-terminal-"));
  const host = await startHost({
    root,
    assets: resolve("dist/ui"),
    helper: resolve("dist/native/suri-helper"),
  });
  const command = (type: string, payload: Record<string, unknown> = {}) => ({
    v: 1 as const,
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    type,
    payload,
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
    host.store.put("project", project);
    host.store.put("workspace", workspace);
    const created = await host.execute(
      command("terminal.create", {
        workspaceId: workspace.id,
        cols: 80,
        rows: 24,
      }),
      "fixture",
    );
    expect(created.status).toBe("completed");
    const health = await control(root, { type: "health" });
    expect(health.activeWork).toBeGreaterThan(0);
    const refused = await host.execute(
      command("host.shutdown", { expectedInstanceId: health.instanceId }),
      "fixture",
    );
    expect(refused).toMatchObject({
      status: "rejected",
      error: { code: "HOST_BUSY" },
    });
    const graceful = await host.execute(
      command("host.shutdown", {
        expectedInstanceId: health.instanceId,
        closeTerminals: true,
      }),
      "fixture",
    );
    expect(graceful).toMatchObject({
      status: "completed",
      result: { stopping: true, instanceId: health.instanceId },
    });
    for (let i = 0; i < 50 && host.resources.activeTerminalCount; i++)
      await new Promise((resolve) => setTimeout(resolve, 20));
    expect(host.resources.activeTerminalCount).toBe(0);
    await host.close();
    expect(() => host.store.list("project")).toThrow();
  } finally {
    await host.close();
    await rm(root, { recursive: true, force: true });
  }
});

it("requires nonce, cookie, canonical origin and CSRF before mutation", async () => {
  const root = await mkdtemp(join(tmpdir(), "suri-host-"));
  const host = await startHost({
    root,
    assets: resolve("dist/ui"),
    helper: resolve("dist/native/suri-helper"),
  });
  try {
    expect((await fetch(host.origin + "/v1/client")).status).toBe(401);
    const b = await control(root, { type: "bootstrap" });
    const options = {
      method: "POST",
      headers: { Origin: host.origin, "Content-Type": "application/json" },
      body: JSON.stringify({ nonce: b.nonce }),
    };
    const r = await fetch(host.origin + "/v1/bootstrap", options);
    expect(r.status).toBe(200);
    const cookie = r.headers.get("set-cookie")!.split(";")[0];
    const { csrf } = (await r.json()) as any;
    expect((await fetch(host.origin + "/v1/bootstrap", options)).status).toBe(
      401,
    );
    const body = JSON.stringify({
      v: 1,
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      type: "catalog.get",
      payload: {},
    });
    expect(
      (
        await fetch(host.origin + "/v1/commands", {
          method: "POST",
          headers: { Cookie: cookie, Origin: "https://evil.invalid" },
          body,
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await fetch(host.origin + "/v1/commands", {
          method: "POST",
          headers: { Cookie: cookie, Origin: host.origin },
          body,
        })
      ).status,
    ).toBe(401);
    const good = await fetch(host.origin + "/v1/commands", {
      method: "POST",
      headers: { Cookie: cookie, Origin: host.origin, "X-Suri-Csrf": csrf },
      body,
    });
    expect(((await good.json()) as any).status).toBe("completed");
  } finally {
    await host.close();
    await rm(root, { recursive: true, force: true });
  }
});
