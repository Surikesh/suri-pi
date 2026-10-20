// F3s phase A: characterizes the bytes the Local CLI sends for each
// command-submitting action BEFORE cli.ts is split. Driven only through the
// public `runCli()` export against a fixture unix control socket (SURI_DATA_DIR)
// and a fixture HTTP server. Id and time are fixed.
//
// Not reachable without real infra: the tail of `restart` (post-shutdown
// ensure()/relaunch of a host). `restart` is characterized up to and including
// the POST /v1/commands body; the flow is then ended by a rejected receipt.
import { mkdtemp, rm } from "node:fs/promises";
import { mkdirSync } from "node:fs";
import {
  createServer as createNetServer,
  type Server as NetServer,
} from "node:net";
import {
  createServer as createHttpServer,
  type Server as HttpServer,
} from "node:http";
import type { AddressInfo } from "node:net";
import { join, resolve } from "node:path";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from "vitest";

vi.mock("node:crypto", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:crypto")>()),
  randomUUID: () => "00000000-0000-4000-8000-000000000001",
}));

const ID = "00000000-0000-4000-8000-000000000001";
const NOW = "2026-01-02T03:04:05.000Z";
const head = `{"v":1,"id":"${ID}","createdAt":"${NOW}"`;

const healthOk = {
  product: "suri-pi",
  protocol: 1,
  uiContract: 1,
  storageSchema: 1,
  capabilities: ["local-browser"],
  instanceId: "inst-1",
  lifecycle: "running",
  activeWork: 0,
};

type Ctl = Record<string, unknown>;
let dir: string;
let runCli: () => Promise<void>;
let ctl: NetServer | undefined;
let http: HttpServer;
let origin = "";
let ctlLog: Ctl[] = [];
let posts: {
  url: string;
  headers: Record<string, string | undefined>;
  body: string;
}[] = [];
let health: Record<string, unknown> = healthOk;
let commandReplies: unknown[] = [];
let onCommand: (() => void) | undefined;
let stdout = "";
let stderr = "";
const savedArgv = process.argv;

function listenControl(): Promise<void> {
  return new Promise((ok) => {
    ctl = createNetServer((s) => {
      let b = "";
      s.on("data", (x) => {
        b += x;
        if (!b.endsWith("\n")) return;
        const req = JSON.parse(b) as Ctl;
        ctlLog.push(req);
        let res: unknown;
        if (req.type === "health") res = health;
        else if (req.type === "bootstrap") res = { origin, nonce: "n-1" };
        else if (req.type === "grant") res = { grantId: `g-${req.kind}` };
        else if (req.type === "runtime-validation-grant")
          res = { grantId: "g-validate" };
        else res = { error: "UNEXPECTED" };
        s.end(JSON.stringify(res));
      });
    });
    ctl.listen(join(dir, "run/control.sock"), ok);
  });
}

beforeAll(async () => {
  dir = await mkdtemp("/tmp/suri-cliA-");
  mkdirSync(join(dir, "run"));
  process.env.SURI_DATA_DIR = dir;
  http = createHttpServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (req.url === "/v1/bootstrap") {
        res.setHeader("set-cookie", "sid=abc; HttpOnly");
        res.end(JSON.stringify({ csrf: "csrf-1" }));
        return;
      }
      posts.push({
        url: req.url!,
        headers: {
          origin: req.headers.origin,
          cookie: req.headers.cookie,
          csrf: req.headers["x-suri-csrf"] as string | undefined,
          type: req.headers["content-type"],
        },
        body,
      });
      res.end(
        JSON.stringify(commandReplies.shift() ?? { status: "completed" }),
      );
      onCommand?.();
    });
  });
  await new Promise<void>((ok) => http.listen(0, "127.0.0.1", ok));
  origin = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  ({ runCli } = await import("../../apps/host/src/cli.js"));
});

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(NOW));
  ctlLog = [];
  posts = [];
  health = healthOk;
  commandReplies = [];
  onCommand = undefined;
  stdout = stderr = "";
  vi.spyOn(process.stdout, "write").mockImplementation(((c: unknown) => {
    stdout += String(c);
    return true;
  }) as never);
  vi.spyOn(console, "log").mockImplementation(
    (...a) => void (stdout += a.join(" ") + "\n"),
  );
  vi.spyOn(console, "error").mockImplementation(
    (...a) => void (stderr += a.join(" ") + "\n"),
  );
  await listenControl();
});

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  process.argv = savedArgv;
  process.exitCode = undefined;
  await new Promise<void>((ok) => (ctl ? ctl.close(() => ok()) : ok()));
  ctl = undefined;
  await rm(join(dir, "run/control.sock"), { force: true });
});

afterAll(async () => {
  await new Promise<void>((ok) => http.close(() => ok()));
  await rm(dir, { recursive: true, force: true });
});

async function run(...args: string[]) {
  process.argv = ["node", "suri", ...args];
  await runCli();
  const exitCode = process.exitCode;
  process.exitCode = undefined;
  return { exitCode, stdout, stderr };
}
const types = () => ctlLog.map((r) => r.type + (r.kind ? `:${r.kind}` : ""));
const bodies = () => posts.map((p) => p.body);

describe("CLI action request bytes", () => {
  test("add-project", async () => {
    const r = await run("add-project", "rel/dir");
    expect(r.exitCode).toBeUndefined();
    expect(bodies()).toEqual([
      `${head},"type":"project.add","payload":{"directoryGrantId":"g-directory"}}`,
    ]);
    expect(
      JSON.stringify({
        type: "project.add",
        payload: { directoryGrantId: "g-directory" },
      }),
    ).toBe(
      '{"type":"project.add","payload":{"directoryGrantId":"g-directory"}}',
    );
    expect(posts[0]).toMatchObject({
      url: "/v1/commands",
      headers: {
        origin,
        cookie: "sid=abc",
        csrf: "csrf-1",
        type: "application/json",
      },
    });
    expect(ctlLog).toEqual([
      { type: "health" },
      { type: "bootstrap" },
      { type: "grant", kind: "directory", path: resolve("rel/dir") },
    ]);
    expect(stdout).toBe('{"status":"completed"}\n');
  });

  test("add-project without a path fails after auth bootstrap with no command POST", async () => {
    const r = await run("add-project");
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("CLI_USAGE");
    expect(posts).toEqual([]);
    expect(types()).toEqual([]);
  });

  test("missing path usage does not launch or bootstrap a host", async () => {
    // No control socket at all: a usage error must not try to launch a host.
    await new Promise<void>((ok) => ctl!.close(() => ok()));
    ctl = undefined;
    await rm(join(dir, "run/control.sock"), { force: true });
    for (const argv of [
      ["add-project"],
      ["add-project", "--no-open"],
      ["import-session"],
      ["import-session", "--flag", "ws-1"],
      ["register-runtime"],
      ["register-runtime", "--confirm"],
      ["validate-runtime"],
      ["validate-runtime", "--provider=p", "--model=m"],
    ]) {
      const r = await run(...argv);
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain("CLI_USAGE");
      expect(r.stderr).not.toContain("HOST_LAUNCH");
    }
    expect(ctlLog).toEqual([]);
    expect(posts).toEqual([]);
  });

  test("import-session full and with omitted optional args", async () => {
    await run("import-session", "/tmp/s.jsonl", "ws-1", "rt-1");
    await run("import-session", "/tmp/s.jsonl");
    expect(bodies()).toEqual([
      `${head},"type":"session.import","payload":{"fileGrantId":"g-file","workspaceId":"ws-1","runtimeId":"rt-1"}}`,
      `${head},"type":"session.import","payload":{"fileGrantId":"g-file"}}`,
    ]);
    expect(types()).toEqual([
      "health",
      "bootstrap",
      "grant:file",
      "health",
      "bootstrap",
      "grant:file",
    ]);
    expect(ctlLog[2]).toEqual({
      type: "grant",
      kind: "file",
      path: "/tmp/s.jsonl",
    });
  });

  test("import-session without args emits no POST", async () => {
    const r = await run("import-session");
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("CLI_USAGE");
    expect(ctlLog).toEqual([]);
    expect(posts).toEqual([]);
  });

  test("catalog sends an empty payload", async () => {
    await run("catalog");
    expect(bodies()).toEqual([`${head},"type":"catalog.get","payload":{}}`]);
    expect(types()).toEqual(["health", "bootstrap"]);
  });

  test("ui-builds sends an empty payload", async () => {
    await run("ui-builds");
    expect(bodies()).toEqual([`${head},"type":"ui.builds","payload":{}}`]);
    expect(types()).toEqual(["health", "bootstrap"]);
  });

  test("register-runtime with and without expected version", async () => {
    await run("register-runtime", "/bin/pi", "1.2.3");
    await run("register-runtime", "/bin/pi");
    expect(bodies()).toEqual([
      `${head},"type":"runtime.register","payload":{"executableGrantId":"g-executable","expectedVersion":"1.2.3"}}`,
      `${head},"type":"runtime.register","payload":{"executableGrantId":"g-executable"}}`,
    ]);
    expect(ctlLog[2]).toEqual({
      type: "grant",
      kind: "executable",
      path: "/bin/pi",
    });
  });

  test("register-runtime without args emits no POST", async () => {
    const r = await run("register-runtime");
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("CLI_USAGE");
    expect(ctlLog).toEqual([]);
    expect(posts).toEqual([]);
  });

  test("activate-ui with and without build id", async () => {
    await run("activate-ui", "b-1");
    await run("activate-ui");
    expect(bodies()).toEqual([
      `${head},"type":"ui.activate","payload":{"buildId":"b-1"}}`,
      `${head},"type":"ui.activate","payload":{}}`,
    ]);
  });

  describe("validate-runtime", () => {
    const flags = [
      "--provider=prov",
      "--model=mod",
      "--agent-dir=ad",
      "--confirm-provider-spend",
    ];

    test("grants validation before bootstrap and sends runtimeId plus grant", async () => {
      await run("validate-runtime", "rt-1", ...flags);
      expect(ctlLog).toEqual([
        { type: "health" },
        {
          type: "runtime-validation-grant",
          provider: "prov",
          model: "mod",
          agentDir: resolve("ad"),
          confirmProviderSpend: true,
        },
        { type: "bootstrap" },
      ]);
      expect(bodies()).toEqual([
        `${head},"type":"runtime.validate","payload":{"runtimeId":"rt-1","validationGrantId":"g-validate"}}`,
      ]);
    });

    test("odd: first argv entry is the runtime id even when it is a flag", async () => {
      const r = await run("validate-runtime", ...flags);
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain("CLI_USAGE");
      expect(ctlLog).toEqual([]);
      expect(posts).toEqual([]);
    });

    test("runtime id is positional before or after validation flags", async () => {
      await run("validate-runtime", "rt-1", ...flags);
      await run("validate-runtime", ...flags, "rt-2");
      await run("validate-runtime", flags[0], "rt-3", ...flags.slice(1));
      const payload = (id: string) =>
        `${head},"type":"runtime.validate","payload":{"runtimeId":"${id}","validationGrantId":"g-validate"}}`;
      expect(bodies()).toEqual([
        payload("rt-1"),
        payload("rt-2"),
        payload("rt-3"),
      ]);
    });

    test("accepted receipt is resubmitted with identical bytes; non-completed sets exit 1", async () => {
      commandReplies = [{ status: "accepted" }, { status: "failed" }];
      const r = await run("validate-runtime", "rt-1", ...flags);
      expect(posts).toHaveLength(2);
      expect(posts[1].body).toBe(posts[0].body);
      expect(r.exitCode).toBe(1);
      expect(r.stdout).toBe('{"status":"failed"}\n');
    });

    test.each([
      [
        "missing confirm",
        ["rt-1", "--provider=p", "--model=m", "--agent-dir=a"],
      ],
      [
        "missing provider",
        ["rt-1", "--model=m", "--agent-dir=a", "--confirm-provider-spend"],
      ],
      [
        "missing model",
        ["rt-1", "--provider=p", "--agent-dir=a", "--confirm-provider-spend"],
      ],
      [
        "missing agent dir",
        ["rt-1", "--provider=p", "--model=m", "--confirm-provider-spend"],
      ],
    ])("rejects %s before any grant or POST", async (_n, args) => {
      const r = await run("validate-runtime", ...args);
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain("RUNTIME_VALIDATION_UNAUTHORIZED");
      expect(types()).toEqual(["health"]);
      expect(posts).toEqual([]);
    });
  });

  describe("shutdown and restart", () => {
    const shutdownBody = `${head},"type":"host.shutdown","payload":{"expectedInstanceId":"inst-1"}}`;

    test("shutdown posts the expected instance id and completes after the socket closes", async () => {
      commandReplies = [
        {
          status: "completed",
          result: { stopping: true, instanceId: "inst-1" },
        },
      ];
      onCommand = () => void ctl?.close();
      const r = await run("shutdown");
      expect(bodies()).toEqual([shutdownBody]);
      // no ensure(): health (lifecycle), bootstrap, then the loop's health probe fails to connect
      expect(types()).toEqual(["health", "bootstrap"]);
      expect(r.stdout).toBe(
        '{"status":"completed","result":{"stopping":true,"instanceId":"inst-1","stopped":true}}\n',
      );
    });

    test("shutdown with an absent host prints present:false and posts nothing", async () => {
      await new Promise<void>((ok) => ctl!.close(() => ok()));
      ctl = undefined;
      await rm(join(dir, "run/control.sock"), { force: true });
      const r = await run("shutdown");
      expect(r.stdout).toBe('{"present":false,"stopped":false}\n');
      expect(posts).toEqual([]);
    });

    test("restart posts the same shutdown body (tail needs real relaunch infra)", async () => {
      commandReplies = [
        { status: "rejected", error: { code: "X", retryable: false } },
      ];
      const r = await run("restart", "--no-open");
      expect(bodies()).toEqual([shutdownBody]);
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain("SHUTDOWN_REJECTED");
    });

    test.each(["shutdown", "restart"])(
      "%s with active work emits no POST",
      async (a) => {
        health = { ...healthOk, activeWork: 2 };
        const r = await run(a);
        expect(r.exitCode).toBe(1);
        expect(r.stderr).toContain("HOST_BUSY");
        expect(posts).toEqual([]);
        expect(types()).toEqual(["health", "bootstrap"]);
      },
    );

    test("restart on uiContract 2 requires exact-target approval and emits no POST", async () => {
      health = { ...healthOk, uiContract: 2 };
      const r = await run("restart");
      expect(r.stderr).toContain("EXACT_TARGET_APPROVAL_REQUIRED");
      expect(posts).toEqual([]);
      expect(types()).toEqual(["health"]);
    });
  });

  test.each([
    ["catalog"],
    ["add-project", "/tmp/x"],
    ["activate-ui", "b"],
    ["shutdown"],
  ])(
    "incompatible health rejects %s with no grant, bootstrap or POST",
    async (...argv) => {
      health = { ...healthOk, protocol: 2 };
      const r = await run(...argv);
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain("INCOMPATIBLE_HOST");
      expect(types()).toEqual(["health"]);
      expect(posts).toEqual([]);
    },
  );

  test("unknown action emits no control request and no POST", async () => {
    const r = await run("frobnicate");
    expect(r.stderr).toContain("UNKNOWN_ACTION");
    expect(ctlLog).toEqual([]);
    expect(posts).toEqual([]);
  });
});
