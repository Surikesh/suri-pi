import { it, expect, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { existsSync, readdirSync } from "node:fs";
import { rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return { ...actual, writeFile: vi.fn(actual.writeFile) };
});
import { Storage } from "../../apps/host/src/storage.js";
import { Assets } from "../../apps/host/src/assets.js";

it("missing asset blobs return a bounded unavailable error after ownership validation", async () => {
  const dir = mkdtempSync(join(tmpdir(), "suri-assets-"));
  const store = new Storage(dir);
  try {
    const project = store.put("project", {
      id: randomUUID(),
      root: dir,
      label: "p",
      revision: 1,
    });
    const workspace = store.put("workspace", {
      id: randomUUID(),
      projectId: project.id,
      root: dir,
      revision: 1,
    });
    const runtime = store.put("runtime", {
      id: randomUUID(),
      executable: "/bin/true",
      version: "0",
      identity: "x",
      status: "verified",
    });
    const session = store.put("session", {
      id: randomUUID(),
      workspaceId: workspace.id,
      runtimeId: runtime.id,
      name: "owner",
      revision: 1,
    });
    const assets = new Assets(store);
    const asset = await assets.upload(
      Buffer.from("hello"),
      "a.txt",
      "text/plain",
      "attachment",
      session.id,
    );
    expect((await assets.read(asset.id, session.id)).bytes.toString()).toBe(
      "hello",
    );
    await rm(join(dir, "assets", asset.id));
    // Ownership is checked first, so another session never learns the blob is gone.
    await expect(assets.read(asset.id, randomUUID())).rejects.toMatchObject({
      code: "PATH_DENIED",
    });
    await expect(assets.read(asset.id, session.id)).rejects.toMatchObject({
      code: "ARTIFACT_UNAVAILABLE",
      message: "The attachment is no longer available.",
      retryable: false,
    });
    await expect(assets.read(randomUUID(), session.id)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

function ownedFixture() {
  const dir = mkdtempSync(join(tmpdir(), "suri-assets-"));
  const store = new Storage(dir);
  const project = store.put("project", {
    id: randomUUID(),
    root: dir,
    label: "p",
    revision: 1,
  });
  const workspace = store.put("workspace", {
    id: randomUUID(),
    projectId: project.id,
    root: dir,
    revision: 1,
  });
  const runtime = store.put("runtime", {
    id: randomUUID(),
    executable: "/bin/true",
    version: "0",
    identity: "x",
    status: "verified",
  });
  const session = store.put("session", {
    id: randomUUID(),
    workspaceId: workspace.id,
    runtimeId: runtime.id,
    name: "owner",
    revision: 1,
  });
  const assets = new Assets(store);
  const upload = (id: string) =>
    assets.upload(
      Buffer.from("hello"),
      "a.txt",
      "text/plain",
      "attachment",
      session.id,
      id,
    );
  const has = (id: string) => {
    try {
      store.get("asset", id);
      return true;
    } catch {
      return false;
    }
  };
  const file = (id: string) => join(dir, "assets", id);
  const done = () => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { dir, store, assets, session, upload, has, file, done };
}

it("discard tracks row and file ownership independently", async () => {
  const f = ownedFixture();
  try {
    // Existing committed row, missing blob: only the new blob may go.
    const a = randomUUID();
    await f.upload(a);
    await rm(f.file(a));
    f.assets.discard(await f.upload(a));
    expect(f.has(a)).toBe(true);
    expect(existsSync(f.file(a))).toBe(false);
    // Existing blob, absent row: only the new row may go.
    const b = randomUUID();
    await f.upload(b);
    f.store.remove("asset", b);
    f.assets.discard(await f.upload(b));
    expect(f.has(b)).toBe(false);
    expect(existsSync(f.file(b))).toBe(true);
    // Fully pre-existing, and fully new.
    const c = randomUUID();
    await f.upload(c);
    f.assets.discard(await f.upload(c));
    expect(f.has(c) && existsSync(f.file(c))).toBe(true);
    const d = await f.upload(randomUUID());
    f.assets.discard(d);
    expect(f.has(d.id) || existsSync(f.file(d.id))).toBe(false);
  } finally {
    f.done();
  }
});

it("a failed initial blob write removes only the partial file this attempt created", async () => {
  const f = ownedFixture();
  const { writeFile: real } =
    await vi.importActual<typeof import("node:fs/promises")>(
      "node:fs/promises",
    );
  // Creates the file, writes two bytes, then fails like ENOSPC.
  const failNextWrite = () =>
    vi.mocked(writeFile).mockImplementationOnce((async (
      path: any,
      bytes: any,
    ) => {
      await real(path, (bytes as Buffer).subarray(0, 2));
      throw Object.assign(new Error("ENOSPC"), { code: "ENOSPC" });
    }) as any);
  const leftovers = () => readdirSync(join(f.dir, "assets")).sort();
  try {
    await f.upload(randomUUID());
    const baseline = leftovers();
    failNextWrite();
    await expect(f.assets.output("big", f.session.id)).rejects.toThrow(
      "ENOSPC",
    );
    const id = randomUUID();
    failNextWrite();
    await expect(f.upload(id)).rejects.toThrow("ENOSPC");
    expect(leftovers()).toEqual(baseline);
    // A pre-existing file with the requested id survives a failed overwrite.
    await f.upload(id);
    failNextWrite();
    await expect(f.upload(id)).rejects.toThrow("ENOSPC");
    expect(existsSync(f.file(id))).toBe(true);
    expect(f.has(id)).toBe(true);
  } finally {
    f.done();
  }
});
