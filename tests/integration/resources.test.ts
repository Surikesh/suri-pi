import { createHash } from "node:crypto";
import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import { it, expect } from "vitest";
import { startHost } from "../../apps/host/src/host.js";
import { control } from "../../apps/host/src/cli.js";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  Resources,
  acquireLock,
  safePath,
} from "../../apps/host/src/resources.js";
it("denies lexical traversal and descriptor-relative symlink escapes", async () => {
  const root = await mkdtemp(join(tmpdir(), "suri-path-"));
  const res = new Resources(resolve("dist/native/suri-helper"), () => {});
  try {
    await mkdir(join(root, "dir"));
    await writeFile(join(root, "dir", "hello world🙂.txt"), "hello");
    await symlink("/etc", join(root, "outside"));
    for (const p of ["../etc", "/etc", "C:/etc", "a\0b", "a/../b", "\\server"])
      expect(() => safePath(p)).toThrow();
    expect((await res.file(root, "dir/hello world🙂.txt", false)).content).toBe(
      "hello",
    );
    await expect(res.file(root, "outside/passwd", false)).rejects.toThrow();
    expect(
      (await res.file(root, ".", true)).entries?.find(
        (e) => e.name === "outside",
      )?.kind,
    ).toBe("symlink");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
it("continues large directory listings from an opaque cursor", async () => {
  const root = await mkdtemp(join(tmpdir(), "suri-page-"));
  const res = new Resources(resolve("dist/native/suri-helper"), () => {});
  try {
    await Promise.all(
      Array.from({ length: 501 }, (_, index) =>
        writeFile(join(root, `entry-${String(index).padStart(3, "0")}`), "x"),
      ),
    );
    const first = await res.file(root, ".", true);
    expect(first.entries).toHaveLength(500);
    expect(first.cursor).toBe("500");
    const second = await res.file(root, ".", true, Number(first.cursor));
    expect(second.entries).toHaveLength(1);
    expect(second.cursor).toBeUndefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
it("atomically saves text with conflict and workspace-boundary checks", async () => {
  const root = await mkdtemp(join(tmpdir(), "suri-save-"));
  const res = new Resources(resolve("dist/native/suri-helper"), () => {});
  try {
    await mkdir(join(root, "dir"));
    await writeFile(join(root, "dir", "letter.txt"), "first draft");
    const first = await res.file(root, "dir/letter.txt", false);
    const saved = await res.writeFile(
      root,
      "dir/letter.txt",
      "corrected draft",
      String(first.revision),
    );
    expect(saved.content).toBe("corrected draft");
    expect(saved.revision).not.toBe(first.revision);
    await writeFile(join(root, "dir", "letter.txt"), "external edit");
    await expect(
      res.writeFile(
        root,
        "dir/letter.txt",
        "stale edit",
        String(saved.revision),
      ),
    ).rejects.toThrow("changed on disk");
    await symlink("/etc/passwd", join(root, "dir", "escape.txt"));
    await expect(
      res.writeFile(root, "dir/escape.txt", "denied", String(saved.revision)),
    ).rejects.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
it("routes macOS file actions without a shell", async () => {
  const root = await mkdtemp(join(tmpdir(), "suri-open-"));
  const calls: Array<{ file: string; args: string[] }> = [];
  const res = new Resources(
    resolve("dist/native/suri-helper"),
    () => {},
    async (file, args) => {
      calls.push({ file, args });
    },
    "darwin",
  );
  try {
    await writeFile(join(root, "letter.txt"), "hello");
    await res.systemFile(root, "letter.txt", "open");
    await res.systemFile(root, "letter.txt", "openWith");
    await res.systemFile(root, "letter.txt", "reveal");
    expect(calls.map((call) => call.file)).toEqual([
      "/usr/bin/open",
      "/usr/bin/osascript",
      "/usr/bin/open",
    ]);
    expect(calls[0].args).toEqual([join(root, "letter.txt")]);
    expect(calls[2].args).toEqual(["-R", join(root, "letter.txt")]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
it("exclusive lock is held by OS and released at owner exit", async () => {
  const root = await mkdtemp(join(tmpdir(), "suri-lock-"));
  const helper = resolve("dist/native/suri-helper");
  const lock = await acquireLock(helper, join(root, "lock"));
  try {
    await expect(acquireLock(helper, join(root, "lock"))).rejects.toThrow(
      "owns",
    );
  } finally {
    lock.stdin.end();
    await new Promise((r) => lock.once("exit", r));
    await rm(root, { recursive: true, force: true });
  }
});
it("applies the terminal limit per workspace rather than globally", async () => {
  const root = await mkdtemp(join(tmpdir(), "suri-pty-limit-"));
  const res = new Resources(resolve("dist/native/suri-helper"), () => {});
  try {
    for (let index = 0; index < 4; index++)
      res.createTerminal(root, "workspace-a", 80, 24);
    expect(() => res.createTerminal(root, "workspace-a", 80, 24)).toThrow(
      "Close a terminal in this workspace first.",
    );
    expect(() => res.createTerminal(root, "workspace-b", 80, 24)).not.toThrow();
  } finally {
    await res.closeAndWait();
    await rm(root, { recursive: true, force: true });
  }
});

it("starts a real PTY, receives output, dedupes input, and closes", async () => {
  const root = await mkdtemp(join(tmpdir(), "suri-pty-"));
  let output = "";
  const res = new Resources(
    resolve("dist/native/suri-helper"),
    (_id, type, p) => {
      if (type === "terminal.output")
        output += Buffer.from(p.data, "base64").toString();
    },
  );
  try {
    const { terminalId } = res.createTerminal(root, "fixture", 80, 24);
    expect(res.activeTerminalCount).toBe(1);
    res.terminal("terminal.input", {
      terminalId,
      inputId: "one",
      data: "printf 'suri-pty-ok\\n'\r",
    });
    res.terminal("terminal.input", {
      terminalId,
      inputId: "one",
      data: "printf 'duplicate'\r",
    });
    for (let i = 0; i < 50 && !output.includes("suri-pty-ok\r\n"); i++)
      await new Promise((r) => setTimeout(r, 50));
    expect(output).toContain("suri-pty-ok");
    expect(output).not.toContain("duplicate");
    res.terminal("terminal.resize", { terminalId, cols: 100, rows: 30 });
    expect(
      res.terminal("terminal.attach", { terminalId }).cursor,
    ).toBeGreaterThan(0);
    await res.closeAndWait();
    expect(res.activeTerminalCount).toBe(0);
  } finally {
    await res.closeAndWait();
    await rm(root, { recursive: true, force: true });
  }
});
it("ranged reads report truncation only when a byte remains", async () => {
  const root = await mkdtemp(join(tmpdir(), "suri-eof-"));
  const res = new Resources(resolve("dist/native/suri-helper"), () => {});
  try {
    const text = "0123456789";
    await writeFile(join(root, "t.txt"), text);
    const read = (o: number, l?: number) =>
      res.file(root, "t.txt", false, o, l);
    for (const offset of [0, 4, 9]) {
      const remaining = text.length - offset;
      const exact = await read(offset, remaining);
      expect(exact).toMatchObject({
        content: text.slice(offset),
        bytes: remaining,
        truncated: false,
      });
      const over = await read(offset, remaining + 1);
      expect(over).toMatchObject({ bytes: remaining, truncated: false });
      expect(over.revision).toBe(exact.revision);
      if (remaining > 1)
        expect(await read(offset, remaining - 1)).toMatchObject({
          bytes: remaining - 1,
          truncated: true,
        });
    }
    expect(await read(10, 1)).toMatchObject({ bytes: 0, truncated: false });
    const short = await read(4, 5);
    expect(short).toMatchObject({
      content: "45678",
      bytes: 5,
      truncated: true,
    });
    expect(short.revision).toBe(
      createHash("sha256").update("45678").digest("hex"),
    );
    await writeFile(join(root, "empty"), "");
    expect(await res.file(root, "empty", false)).toMatchObject({
      content: "",
      bytes: 0,
      truncated: false,
    });
    await writeFile(join(root, "b.bin"), Buffer.from([0, 0xff, 0xfe, 0xfd]));
    expect(await res.file(root, "b.bin", false, 1, 3)).toMatchObject({
      encoding: "base64",
      content: Buffer.from([0xff, 0xfe, 0xfd]).toString("base64"),
      bytes: 3,
      truncated: false,
    });
    expect(await res.file(root, "b.bin", false, 1, 2)).toMatchObject({
      bytes: 2,
      truncated: true,
    });
    const cap = 1048576;
    await writeFile(join(root, "cap"), "a".repeat(cap));
    await writeFile(join(root, "over"), "a".repeat(cap + 1));
    expect(await res.file(root, "cap", false)).toMatchObject({
      bytes: cap,
      truncated: false,
    });
    const capped = await res.file(root, "over", false);
    expect(capped).toMatchObject({ bytes: cap, truncated: true });
    expect(capped.content).toHaveLength(cap);
    // A request above the public cap is still clamped to 1 MiB.
    expect(await res.file(root, "over", false, 0, cap * 2)).toMatchObject({
      bytes: cap,
      truncated: true,
    });
    await expect(res.file(root, "t.txt", false, 0, 0)).rejects.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("terminal subscription snapshots use the PTY buffer and cursor, not session projection", async () => {
  const root = await mkdtemp(join(tmpdir(), "suri-term-snap-"));
  const host = await startHost({
    root,
    assets: resolve("dist/ui"),
    helper: resolve("dist/native/suri-helper"),
  });
  const sockets: WebSocket[] = [];
  try {
    const project = { id: randomUUID(), root, label: "f", revision: 1 };
    const workspace = {
      id: randomUUID(),
      projectId: project.id,
      root,
      label: "f",
      revision: 1,
    };
    host.store.put("project", project);
    host.store.put("workspace", workspace);
    const run = async (type: string, payload: Record<string, unknown>) =>
      (await host.execute(
        {
          v: 1,
          id: randomUUID(),
          createdAt: new Date().toISOString(),
          type,
          payload,
        } as never,
        "terminal-test",
      )) as { status: string; result: any };
    const { nonce } = await control(root, { type: "bootstrap" });
    const boot = await fetch(host.origin + "/v1/bootstrap", {
      method: "POST",
      headers: { Origin: host.origin },
      body: JSON.stringify({ nonce }),
    });
    const cookie = boot.headers.get("set-cookie")!.split(";")[0];
    const connect = () =>
      new Promise<{ ws: WebSocket; frames: any[] }>((done) => {
        const ws = new WebSocket(
          host.origin.replace("http", "ws") + "/v1/events",
          {
            headers: { Cookie: cookie, Origin: host.origin },
          },
        );
        sockets.push(ws);
        const frames: any[] = [];
        ws.on("message", (b) => frames.push(JSON.parse(b.toString())));
        ws.on("open", () => done({ ws, frames }));
      });
    const until = async (frames: any[], p: (f: any) => boolean) => {
      for (let i = 0; i < 200 && !frames.some(p); i++)
        await new Promise((r) => setTimeout(r, 25));
      expect(frames.some(p)).toBe(true);
      return frames.find(p);
    };
    const { terminalId } = (
      await run("terminal.create", {
        workspaceId: workspace.id,
        cols: 80,
        rows: 24,
      })
    ).result;
    const stream = `terminal:${terminalId}`;
    await run("terminal.input", {
      terminalId,
      inputId: "i1",
      data: "echo snap-marker\r",
    });
    // Existing terminal: snapshot is the PTY buffer, cursor is its seq.
    const first = await connect();
    for (let i = 0; i < 200; i++) {
      const { data } = (await run("terminal.attach", { terminalId })).result;
      if (Buffer.from(data, "base64").toString().includes("snap-marker")) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    first.ws.send(
      JSON.stringify({ v: 1, type: "subscribe", streamId: stream }),
    );
    const snap = await until(first.frames, (f) => f.type === "snapshot");
    const attach = (await run("terminal.attach", { terminalId })).result;
    expect(Object.keys(snap.payload).sort()).toEqual([
      "cursor",
      "data",
      "phase",
      "terminalId",
    ]);
    expect(snap).toMatchObject({ streamId: stream, seq: snap.payload.cursor });
    expect(snap.payload).toMatchObject({ terminalId, phase: "running" });
    expect(snap.payload.cursor).toBeGreaterThan(0);
    expect(Buffer.from(snap.payload.data, "base64").length).toBeGreaterThan(0);
    expect(attach.cursor).toBeGreaterThanOrEqual(snap.payload.cursor);
    // Resumable subscribe still sends the terminal snapshot, never journal replay.
    const second = await connect();
    second.ws.send(
      JSON.stringify({
        v: 1,
        type: "subscribe",
        streamId: stream,
        afterSeq: 0,
        hostEpoch: host.store.epoch,
      }),
    );
    const resumed = await until(second.frames, (f) => f.type === "snapshot");
    expect(resumed.payload).toMatchObject({ terminalId, phase: "running" });
    expect(resumed.payload).not.toHaveProperty("messages");
    // Live ordering intact: later output carries a cursor beyond the snapshot.
    await run("terminal.input", {
      terminalId,
      inputId: "i2",
      data: "echo more\r",
    });
    const live = await until(
      first.frames,
      (f) => f.type === "terminal.output" && f.seq > snap.payload.cursor,
    );
    expect(live.seq).toBe(live.payload.cursor);
    // Exited terminal still snapshots with phase exited.
    await run("terminal.close", { terminalId });
    await until(first.frames, (f) => f.type === "terminal.state");
    const third = await connect();
    third.ws.send(
      JSON.stringify({ v: 1, type: "subscribe", streamId: stream }),
    );
    expect(
      (await until(third.frames, (f) => f.type === "snapshot")).payload.phase,
    ).toBe("exited");
    // Missing terminal: policy close, no phantom projection.
    const fourth = await connect();
    const closed = new Promise<number>((r) => fourth.ws.once("close", r));
    fourth.ws.send(
      JSON.stringify({
        v: 1,
        type: "subscribe",
        streamId: `terminal:${randomUUID()}`,
      }),
    );
    expect(await closed).toBe(1008);
    expect(fourth.frames).toEqual([]);
  } finally {
    for (const socket of sockets) socket.terminate();
    await host.close();
    await rm(root, { recursive: true, force: true });
  }
});

it("escalates terminal shutdown to SIGKILL when SIGHUP is ignored", async () => {
  const signals: string[] = [];
  let onExit: (e: { exitCode: number; signal?: number }) => void = () => {};
  const fake = {
    onData: () => ({ dispose() {} }),
    onExit: (cb: typeof onExit) => {
      onExit = cb;
      return { dispose() {} };
    },
    kill: (signal = "SIGHUP") => {
      signals.push(signal);
      if (signal === "SIGKILL") onExit({ exitCode: 0 });
    },
  };
  const res = new Resources(
    resolve("dist/native/suri-helper"),
    () => {},
    undefined,
    undefined,
    (() => fake) as never,
  );
  res.createTerminal(tmpdir(), "workspace-a", 80, 24);
  const started = Date.now();
  await res.closeAndWait(5000);
  expect(signals).toEqual(["SIGHUP", "SIGKILL"]);
  expect(Date.now() - started).toBeLessThan(3000);
});
