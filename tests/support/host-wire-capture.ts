import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { request } from "node:http";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import crypto from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { vi } from "vitest";
import WebSocket from "ws";
import { startHost } from "../../apps/host/src/host.js";
import { control } from "../../apps/host/src/cli.js";

/**
 * Shared seams for the F3c pre-move wire/scheduling characterization.
 *
 * Deterministic seams (host.ts + storage.ts + framing.ts read these at call time):
 *  - crypto.randomUUID  -> 00000000-0000-4000-8000-<counter>
 *  - crypto.randomBytes -> bytes filled with the counter value (host token())
 *  - Date (only Date, never timers) -> frozen at FIXED_TIME
 *
 * MASK LIST (the only inherently variable fields; applied by `mask` to every
 * captured string):
 *  1. loopback port          -> <PORT>   (Host/Origin text, `suri_<port>` cookie name)
 *  2. profile root, workspace and temp paths (also their realpath) -> <ROOT>, <WORKSPACE>
 *  3. host and child process ids ("pid"/"processPid" values)       -> "<PID>"
 *  4. UUIDs minted by the external fixture Pi child process, which cannot be
 *     seeded (any UUID not in the seeded 00000000-0000-4000-8000-* range) -> <EXTERNAL-UUID>
 *  5. HTTP `Date` response header value                            -> <HTTP-DATE>
 *  6. terminal pty bytes/cursor/exit code (shell dependent)        -> masked in the test
 * Nothing else is masked.
 */
export const FIXED_TIME = "2026-01-02T03:04:05.000Z";
export const seededUuid = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

export function installSeams() {
  let counter = 0;
  vi.spyOn(crypto, "randomUUID").mockImplementation((() =>
    seededUuid(++counter)) as typeof crypto.randomUUID);
  vi.spyOn(crypto, "randomBytes").mockImplementation(((size: number) =>
    Buffer.alloc(size, ++counter % 256)) as typeof crypto.randomBytes);
  syncBuiltinESMExports();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(FIXED_TIME));
  return {
    get counter() {
      return counter;
    },
  };
}
export function removeSeams() {
  vi.useRealTimers();
  vi.restoreAllMocks();
  syncBuiltinESMExports();
}

export async function wireFixture(options: { validation?: boolean } = {}) {
  const base = await realpath(await mkdtemp(join(tmpdir(), "suri-wire-")));
  const data = join(base, "data");
  const workspace = join(base, "workspace");
  const assets = join(base, "assets");
  const runtimeDir = join(base, "fake-pi");
  await mkdir(workspace);
  await mkdir(assets);
  await mkdir(join(runtimeDir, "dist"), { recursive: true });
  await writeFile(
    join(assets, "index.html"),
    "<!doctype html><p>wire fixture</p>\n",
  );
  await writeFile(join(workspace, "hello.txt"), "first line\nsecond line\n");
  await writeFile(
    join(runtimeDir, "package.json"),
    JSON.stringify({
      name: "@earendil-works/pi-coding-agent",
      version: "0.85.1",
      type: "module",
    }),
  );
  const executable = join(runtimeDir, "dist/cli.mjs");
  await copyFile("tests/fixtures/fake-pi.mjs", executable);
  await chmod(executable, 0o755);
  const hostOptions = {
    root: data,
    assets,
    helper: resolve("dist/native/suri-helper"),
    validation: options.validation ?? true,
    simulated: true,
    directoryHome: workspace,
  };
  const host = await startHost(hostOptions);
  const port = Number(new URL(host.origin).port);
  const uuid = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
  /** See MASK LIST above. */
  const mask = (text: string) =>
    text
      .replaceAll(`127.0.0.1:${port}`, "127.0.0.1:<PORT>")
      .replaceAll(`suri_${port}`, "suri_<PORT>")
      .replaceAll(data, "<ROOT>")
      .replaceAll(workspace, "<WORKSPACE>")
      .replaceAll(base, "<TMP>")
      .replace(/"(pid|processPid)":\d+/g, '"$1":"<PID>"')
      .replace(uuid, (id) =>
        id.startsWith("00000000-0000-4000-8000-") ? id : "<EXTERNAL-UUID>",
      );
  type Raw = { status: number; headers: string[]; body: string };
  /** One HTTP exchange; headers keep the server's emission order and case. */
  const http = (
    path: string,
    init: {
      method?: string;
      headers?: Record<string, string>;
      body?: string;
    } = {},
  ) =>
    new Promise<Raw>((done, fail) => {
      const req = request(
        {
          host: "127.0.0.1",
          port,
          path,
          method: init.method ?? "GET",
          headers: init.headers,
          agent: false,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk) => chunks.push(chunk));
          res.on("end", () => {
            const headers: string[] = [];
            for (let i = 0; i < res.rawHeaders.length; i += 2) {
              const name = res.rawHeaders[i];
              const value =
                name.toLowerCase() === "date"
                  ? "<HTTP-DATE>"
                  : res.rawHeaders[i + 1];
              headers.push(`${name}: ${value}`);
            }
            done({
              status: res.statusCode ?? 0,
              headers,
              body: Buffer.concat(chunks).toString(),
            });
          });
        },
      );
      req.on("error", fail);
      req.end(init.body);
    });
  /** Headers every response starts with; pinned once in the test, elided here. */
  const commonHeaders = [
    "X-Content-Type-Options: nosniff",
    "Referrer-Policy: no-referrer",
    "Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob:; connect-src 'self'; font-src 'self'; frame-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  ];
  const render = (raw: Raw) => {
    const common = commonHeaders.every((line, i) => raw.headers[i] === line);
    const headers = common
      ? ["<common headers>", ...raw.headers.slice(commonHeaders.length)]
      : raw.headers;
    return mask([`HTTP ${raw.status}`, ...headers, "", raw.body].join("\n"));
  };
  /** Raw control-socket exchange returning the exact bytes written back. */
  const controlRaw = (line: string) =>
    new Promise<string>((done, fail) => {
      const socket = createConnection(host.socketPath);
      let bytes = "";
      socket.on("connect", () => socket.write(line));
      socket.on("data", (chunk) => (bytes += chunk));
      socket.on("end", () => done(bytes));
      socket.on("error", fail);
    });
  const login = async () => {
    const { nonce } = await control(data, { type: "bootstrap" });
    const response = await http("/v1/bootstrap", {
      method: "POST",
      headers: { Origin: host.origin, "Content-Type": "application/json" },
      body: JSON.stringify({ nonce }),
    });
    const cookie = response.headers
      .find((header) => header.startsWith("Set-Cookie: "))!
      .slice(12)
      .split(";")[0];
    const { csrf, clientId } = JSON.parse(response.body);
    return { cookie, csrf, clientId, raw: response };
  };
  type Session = Awaited<ReturnType<typeof login>>;
  const post = (s: Session, path: string, value: unknown) =>
    http(path, {
      method: "POST",
      headers: { Cookie: s.cookie, Origin: host.origin, "X-Suri-Csrf": s.csrf },
      body: JSON.stringify(value),
    });
  const envelope = (
    type: string,
    payload: Record<string, unknown> = {},
    extra: Record<string, unknown> = {},
  ) => ({
    v: 1 as const,
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    type,
    payload,
    ...extra,
  });
  /** Real ws client recording every text frame verbatim. */
  const connect = async (s: Session) => {
    const frames: string[] = [];
    const waiters: { p: (frame: string) => boolean; resolve: () => void }[] =
      [];
    const socket = new WebSocket(
      host.origin.replace("http", "ws") + "/v1/events",
      {
        headers: { Cookie: s.cookie, Origin: host.origin },
      },
    );
    socket.on("message", (bytes, binary) => {
      const text = bytes.toString();
      frames.push(binary ? `<binary>${text}` : text);
      for (const w of [...waiters])
        if (w.p(text)) {
          waiters.splice(waiters.indexOf(w), 1);
          w.resolve();
        }
    });
    const closed = new Promise<number>((done) =>
      socket.on("close", (code) => done(code)),
    );
    await new Promise<void>((done, fail) => {
      socket.on("open", () => done());
      socket.on("error", fail);
    });
    return {
      socket,
      frames,
      closed,
      send: (value: unknown) => socket.send(JSON.stringify(value)),
      until: (p: (frame: string) => boolean) =>
        new Promise<void>((resolve) => {
          if (frames.some(p)) resolve();
          else waiters.push({ p, resolve });
        }),
    };
  };
  const grant = async (kind: string, path: string) =>
    (await control(data, { type: "grant", kind, path })).grantId as string;
  return {
    host,
    data,
    workspace,
    executable,
    port,
    mask,
    http,
    render,
    commonHeaders,
    controlRaw,
    login,
    post,
    envelope,
    connect,
    grant,
    async cleanup() {
      await host.close();
      await rm(base, { recursive: true, force: true });
    },
  };
}
export type WireFixture = Awaited<ReturnType<typeof wireFixture>>;

/** sha256 of each file under tests/fixtures/pi/<version>, sorted by path. */
export async function fixtureHashes() {
  const lines: string[] = [];
  for (const version of ["0.84.4", "0.85.1"]) {
    const dir = join("tests/fixtures/pi", version);
    for (const name of (await readdir(dir)).sort())
      lines.push(
        `${version}/${name} ${createHash("sha256")
          .update(await readFile(join(dir, name)))
          .digest("hex")}`,
      );
  }
  return lines;
}

/** Project + runtime + workspace + session through public HTTP commands. */
export async function seedSession(
  f: WireFixture,
  login: Awaited<ReturnType<WireFixture["login"]>>,
) {
  const cmd = async (
    type: string,
    payload: Record<string, unknown> = {},
    extra: Record<string, unknown> = {},
  ) =>
    JSON.parse(
      (await f.post(login, "/v1/commands", f.envelope(type, payload, extra)))
        .body,
    );
  await cmd("project.add", {
    directoryGrantId: await f.grant("directory", f.workspace),
  });
  const runtime = (
    await cmd("runtime.register", {
      executableGrantId: await f.grant("executable", f.executable),
      expectedVersion: "0.85.1",
    })
  ).result;
  const workspace = (f.host.store.list("workspace") as { id: string }[])[0];
  const session = (
    await cmd("session.create", {
      workspaceId: workspace.id,
      runtimeId: runtime.id,
    })
  ).result;
  return { cmd, session, workspace };
}
