import { test, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { updateFixture } from "../support/update-fixture.js";

test("concurrent baseline readiness is idempotent; shared-cookie windows own separate drafts", async () => {
  const fixture = await updateFixture();
  const auth = randomUUID(),
    a = randomUUID(),
    b = randomUUID();
  try {
    const session = await fixture.seed();
    const project = fixture.host.store.list("project")[0];
    const icons = await Promise.all(
      [a, b].map(() =>
        fixture.execute(
          "project.discoverIcon",
          { projectId: project.id },
          auth,
        ),
      ),
    );
    expect(icons.map((receipt) => receipt.status)).toEqual([
      "completed",
      "completed",
    ]);
    expect(fixture.host.store.get("project", project.id).revision).toBe(
      project.revision,
    );
    for (const clientInstanceId of [a, b])
      expect(
        (
          await fixture.execute(
            "updates.client",
            {
              clientInstanceId,
              surface: "browser",
              loadedUiId: fixture.baseline.id,
              mode: "follow",
            },
            auth,
          )
        ).status,
      ).toBe("completed");
    const instance = (await fixture.health()).instanceId;
    const pendingDiscovery = fixture.execute(
      "project.discoverIcon",
      { projectId: project.id },
      auth,
    );
    const shutdown = await fixture.execute(
      "host.shutdown",
      { expectedInstanceId: instance },
      auth,
    );
    expect(shutdown.error?.code).toBe("HOST_BUSY");
    expect((await pendingDiscovery).status).toBe("completed");
    expect((await fixture.health()).instanceId).toBe(instance);
    const receipts = await Promise.all(
      [a, b].map((clientInstanceId) =>
        fixture.execute(
          "ui.ready",
          {
            clientInstanceId,
            operationId: null,
            buildId: fixture.baseline.id,
            checkpointRevision: 0,
            hostInstanceId: instance,
            catalogSeq: 0,
          },
          auth,
        ),
      ),
    );
    expect(receipts.map((r) => r.status)).toEqual(["completed", "completed"]);
    for (const [clientInstanceId, text] of [
      [a, "Draft A"],
      [b, "Draft B"],
    ])
      expect(
        (
          await fixture.execute(
            "draft.save",
            { clientInstanceId, text, attachmentIds: [] },
            auth,
            session.id,
          )
        ).status,
      ).toBe("completed");
    expect(
      (
        await fixture.execute(
          "draft.get",
          { clientInstanceId: a },
          auth,
          session.id,
        )
      ).result?.text,
    ).toBe("Draft A");
    expect(
      (
        await fixture.execute(
          "draft.get",
          { clientInstanceId: b },
          auth,
          session.id,
        )
      ).result?.text,
    ).toBe("Draft B");
    await fixture.execute("model.list", {}, auth, session.id);
    fixture.host.publish(`session:${session.id}`, "queue.state", {
      items: [
        { mode: "followUp", text: "Queued only for B", attachmentIds: [] },
      ],
    });
    expect(
      (
        await fixture.execute(
          "queue.clear",
          { clientInstanceId: b },
          auth,
          session.id,
        )
      ).status,
    ).toBe("accepted");
    await expect
      .poll(() => fixture.host.store.get("draft", `${session.id}:${b}`).text)
      .toBe("Draft B\n\nQueued only for B");
    expect(fixture.host.store.get("draft", `${session.id}:${a}`).text).toBe(
      "Draft A",
    );
    expect(fixture.host.store.get("draft", `${session.id}:${b}`).revision).toBe(
      2,
    );
    expect(
      (
        await fixture.execute(
          "draft.get",
          { clientInstanceId: a },
          randomUUID(),
          session.id,
        )
      ).error?.code,
    ).toBe("UNAUTHORIZED");
    expect(
      (
        await fixture.execute(
          "draft.save",
          { text: "overwrite", attachmentIds: [] },
          auth,
          session.id,
        )
      ).error?.code,
    ).toBe("UNAUTHORIZED");
  } finally {
    await fixture.close();
  }
});

test("shared restart admission protects fake-runtime phases and queued work without replacing owned processes", async () => {
  const fixture = await updateFixture();
  const auth = randomUUID();
  try {
    const session = await fixture.seed();
    // Listing is passive; only an explicit resume starts the fake child.
    expect(
      (await fixture.execute("model.list", {}, auth, session.id)).status,
    ).toBe("rejected");
    expect(fixture.host.children.size).toBe(0);
    expect(
      (await fixture.execute("session.resume", {}, auth, session.id)).status,
    ).toBe("accepted");
    await expect.poll(() => fixture.host.children.has(session.id)).toBe(true);
    await expect
      .poll(() => fixture.host.store.snapshot(`session:${session.id}`).phase)
      .toBe("idle");
    expect(
      (await fixture.execute("model.list", {}, auth, session.id)).status,
    ).toBe("completed");
    const before = await fixture.health();
    const child = fixture.host.children.get(session.id)!.child;
    for (const phase of [
      "starting",
      "running",
      "waiting",
      "compacting",
      "retrying",
      "cancelling",
    ]) {
      fixture.host.publish(`session:${session.id}`, "run.state", { phase });
      const status = (await fixture.execute("updates.get", {}, auth)).result;
      expect(status?.restart.work.blockers).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: "sessions-or-rpc", count: 1 }),
        ]),
      );
      expect(
        (
          await fixture.execute(
            "host.shutdown",
            { expectedInstanceId: before.instanceId },
            auth,
          )
        ).error?.code,
      ).toBe("HOST_BUSY");
      expect((await fixture.health()).instanceId).toBe(before.instanceId);
      expect(child.exitCode).toBeNull();
    }
    fixture.host.publish(`session:${session.id}`, "run.state", {
      phase: "idle",
    });
    fixture.host.publish(`session:${session.id}`, "queue.state", {
      items: [{ mode: "followUp", text: "queued fixture" }],
    });
    expect(
      (
        await fixture.execute(
          "host.shutdown",
          { expectedInstanceId: before.instanceId },
          auth,
        )
      ).error?.code,
    ).toBe("HOST_BUSY");
    expect(fixture.host.children.get(session.id)!.child.pid).toBe(child.pid);
    fixture.host.publish(`session:${session.id}`, "queue.state", { items: [] });
  } finally {
    await fixture.close();
  }
});
