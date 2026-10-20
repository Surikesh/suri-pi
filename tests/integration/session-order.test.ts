import { it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { browserHost } from "../support/browser-host.js";
import { Storage } from "../../apps/host/src/storage.js";

it("session reordering persists, preserves ownership and rolls back stale or invalid groups", async () => {
  const fixture = await browserHost();
  let reloaded: Storage | undefined;
  try {
    const first = fixture.host.store.get("session", fixture.session.id);
    const second = await fixture.execute("session.create", {
      workspaceId: fixture.workspaceId,
      runtimeId: fixture.runtime.id,
      name: "Second",
    });
    const third = await fixture.execute("session.create", {
      workspaceId: fixture.workspaceId,
      runtimeId: fixture.runtime.id,
      name: "Third",
    });
    const ids = [first.id, second.id, third.id];
    const revisions = () =>
      Object.fromEntries(
        ids.map((id) => [id, fixture.host.store.get("session", id).revision]),
      );
    const beforeOwnership = ids.map((id) => {
      const item = fixture.host.store.get("session", id);
      return [id, item.workspaceId, item.runtimeId, item.parentId];
    });
    const submit = (sessionIds: string[], revs = revisions()) =>
      fixture.host.execute(
        {
          v: 1,
          id: randomUUID(),
          createdAt: new Date().toISOString(),
          type: "session.reorder",
          payload: { sessionIds, revisions: revs },
        },
        "order-fixture",
      );
    expect((await submit([...ids].reverse())).status).toBe("completed");
    expect(
      ids.map((id) => fixture.host.store.get("session", id).order),
    ).toEqual([2, 1, 0]);
    reloaded = new Storage(fixture.data);
    expect(ids.map((id) => reloaded!.get("session", id).order)).toEqual([
      2, 1, 0,
    ]);
    reloaded.close();
    reloaded = undefined;

    const before = ids.map((id) => fixture.host.store.get("session", id));
    const stale = revisions();
    stale[third.id]--;
    expect((await submit(ids, stale)).status).toBe("rejected");
    expect(ids.map((id) => fixture.host.store.get("session", id))).toEqual(
      before,
    );
    const missing = revisions();
    delete missing[third.id];
    expect((await submit(ids, missing)).status).toBe("rejected");
    expect(ids.map((id) => fixture.host.store.get("session", id))).toEqual(
      before,
    );

    for (const field of ["pinned", "archived"]) {
      const item = fixture.host.store.get("session", third.id);
      fixture.host.store.patch("session", third.id, item.revision, {
        [field]: true,
      });
      const groupedBefore = ids.map((id) =>
        fixture.host.store.get("session", id),
      );
      expect((await submit(ids)).status).toBe("rejected");
      expect(ids.map((id) => fixture.host.store.get("session", id))).toEqual(
        groupedBefore,
      );
      const changed = fixture.host.store.get("session", third.id);
      fixture.host.store.patch("session", third.id, changed.revision, {
        [field]: false,
      });
    }
    const workspace = fixture.host.store.get("workspace", fixture.workspaceId);
    await mkdir(join(fixture.root, "other-workspace"));
    const otherWorkspace = fixture.host.store.put("workspace", {
      ...workspace,
      id: randomUUID(),
      root: join(fixture.root, "other-workspace"),
      revision: 1,
    });
    const other = await fixture.execute("session.create", {
      workspaceId: otherWorkspace.id,
      runtimeId: fixture.runtime.id,
      name: "Other workspace",
    });
    const crossBefore = [...ids, other.id].map((id) =>
      fixture.host.store.get("session", id),
    );
    expect(
      (
        await submit([first.id, other.id], {
          ...revisions(),
          [other.id]: other.revision,
        })
      ).status,
    ).toBe("rejected");
    expect(
      [...ids, other.id].map((id) => fixture.host.store.get("session", id)),
    ).toEqual(crossBefore);
    expect((await submit([first.id, first.id])).status).toBe("rejected");
    expect((await submit([])).status).toBe("rejected");

    const raceRevisions = revisions();
    const raced = await Promise.all([
      submit(ids, raceRevisions),
      submit([...ids].reverse(), raceRevisions),
    ]);
    expect(raced.map((receipt) => receipt.status).sort()).toEqual([
      "completed",
      "rejected",
    ]);
    expect(
      ids.map((id) => fixture.host.store.get("session", id).order),
    ).toEqual([0, 1, 2]);
    expect(
      ids.map((id) => {
        const item = fixture.host.store.get("session", id);
        return [id, item.workspaceId, item.runtimeId, item.parentId];
      }),
    ).toEqual(beforeOwnership);
  } finally {
    reloaded?.close();
    await fixture.close();
  }
});
