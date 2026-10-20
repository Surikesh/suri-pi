import { it, expect } from "vitest";
import { browserHost } from "../support/browser-host.js";
import { control } from "../../apps/host/src/cli.js";

it("supports eleven runtimes and retires only idle persisted sessions, then resumes", async () => {
  const fixture = await browserHost();
  try {
    const ids = [fixture.session.id];
    for (let i = 0; i < 10; i++) {
      const session = await fixture.execute("session.create", {
        workspaceId: fixture.session.workspaceId,
        runtimeId: fixture.runtime.id,
      });
      ids.push(session.id);
    }
    // Observational context reads never create runtimes. Explicit resume owns
    // startup, while later reads use the live process or cached metrics.
    for (const id of ids) {
      expect(await fixture.execute("session.context", {}, id)).toMatchObject({
        available: false,
      });
    }
    expect(fixture.host.children.size).toBe(0);
    for (const id of ids) await fixture.execute("session.resume", {}, id);
    await expect.poll(() => fixture.host.children.size).toBe(11);
    await expect
      .poll(
        () =>
          ids.every(
            (id) =>
              fixture.host.store.snapshot(`session:${id}`).phase === "idle",
          ),
        { timeout: 10_000 },
      )
      .toBe(true);
    fixture.host.reapIdleRuntimes();
    expect(fixture.host.children.size).toBe(11);
    const protectedId = ids[0];
    fixture.host.store.event(`session:${protectedId}`, "session.state", {
      phase: "running",
    });
    const resumeId = ids[1];
    const before = fixture.host.store.get("session", resumeId);
    fixture.host.reapIdleRuntimes(Date.now() + 16 * 60_000);
    await expect.poll(() => fixture.host.children.size).toBe(1);
    expect(fixture.host.children.has(protectedId)).toBe(true);
    expect(fixture.host.store.snapshot(`session:${resumeId}`).phase).toBe(
      "closed",
    );
    expect(fixture.host.store.get("session", resumeId).piFile).toBe(
      before.piFile,
    );
    await fixture.execute("session.context", {}, resumeId);
    expect(fixture.host.children.size).toBe(1);
    const coldCommands = await fixture.execute("commands.list", {}, resumeId);
    expect(coldCommands).toMatchObject({
      runtimeAvailable: false,
      commands: expect.arrayContaining([
        expect.objectContaining({ name: "compact", source: "builtin" }),
      ]),
    });
    expect(fixture.host.children.size).toBe(1);
    await fixture.execute("session.resume", {}, resumeId);
    await expect.poll(() => fixture.host.children.size).toBe(2);
    expect(fixture.host.store.get("session", resumeId).processPid).not.toBe(
      before.processPid,
    );
  } finally {
    await fixture.close();
  }
}, 30_000);

it("counts every active owner while bounding health diagnostics to fifty", async () => {
  const fixture = await browserHost();
  try {
    const ids = [fixture.session.id];
    for (let index = 0; index < 59; index++) {
      const session = await fixture.execute("session.create", {
        workspaceId: fixture.session.workspaceId,
        runtimeId: fixture.runtime.id,
      });
      ids.push(session.id);
    }
    for (const [index, id] of ids.entries()) {
      fixture.host.children.set(id, {
        hasPendingRequests: index < 55,
        startupAttemptId: `attempt-${index}`,
        closeAndWait: async () => {},
      } as any);
    }

    const health = await control(fixture.data, { type: "health" });
    const sessions = health.work.blockers.find(
      (blocker: any) => blocker.kind === "sessions-or-rpc",
    );
    expect(sessions).toMatchObject({ count: 55, truncated: true });
    expect(sessions.owners).toHaveLength(50);
    expect(health.activeWork).toBe(55);
  } finally {
    fixture.host.children.clear();
    await fixture.close();
  }
});
