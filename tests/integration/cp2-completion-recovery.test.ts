import { expect, it } from "vitest";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { browserHost } from "../support/browser-host.js";
import { startHost } from "../../apps/host/src/host.js";
import { Storage } from "../../apps/host/src/storage.js";

// R18: a real host process accepts an async command and is SIGKILLed before
// its completion is saved; restarts recover the marked receipt exactly once.
// Only disposable child hosts are killed; the runtime validator is a fixture
// that never reaches a provider.
const child = `
import { appendFileSync, writeFileSync } from "node:fs";
const [hostUrl, cliUrl, mode, optionsJson, commandsJson, outFile] = process.argv.slice(1);
const options = JSON.parse(optionsJson);
const commands = JSON.parse(commandsJson);
const kill = () => process.kill(process.pid, "SIGKILL");
if (mode === "validate")
  options.runtimeValidator = {
    validateAndPromote: async () => {
      appendFileSync(options.runsFile, "validate\\n");
      kill();
      await new Promise(() => {});
    },
  };
const { startHost } = await import(hostUrl);
const host = await startHost(options);
if (mode === "validate") {
  const { control } = await import(cliUrl);
  const grant = await control(options.root, {
    type: "runtime-validation-grant",
    provider: "fixture",
    model: "fixture",
    agentDir: "/tmp",
    confirmProviderSpend: true,
  });
  commands[0].payload.validationGrantId = grant.grantId;
}
if (mode === "submit") {
  await host.execute(commands[0], "crash-child");
  while (host.store.commandReceipt(commands[0].id)?.status !== "completed")
    await new Promise((done) => setImmediate(done));
  commands.shift();
}
const receipt = await host.execute(commands[0], "crash-child");
writeFileSync(outFile, JSON.stringify(commands[0]));
if (receipt.status !== "accepted") process.exit(3);
if (mode !== "validate") kill();
await new Promise(() => {});
`;

type Row = Record<string, any>;
const url = (path: string) => pathToFileURL(resolve(path)).href;
async function crash(
  mode: string,
  options: Row,
  commands: Row[],
  outFile: string,
) {
  const proc = spawn(
    process.execPath,
    [
      "--import",
      import.meta.resolve("tsx"),
      "--input-type=module",
      "-e",
      child,
      url("apps/host/src/host.ts"),
      url("apps/host/src/cli.ts"),
      mode,
      JSON.stringify(options),
      JSON.stringify(commands),
      outFile,
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  let stderr = "";
  proc.stderr.on("data", (chunk) => (stderr += chunk));
  const [code, signal] = await once(proc, "exit");
  expect({ code, signal, stderr: stderr.slice(0, 400) }).toMatchObject({
    signal: "SIGKILL",
  });
  return JSON.parse(await readFile(outFile, "utf8")) as Row;
}
const envelope = (type: string, sessionId?: string, payload: Row = {}) => ({
  v: 1 as const,
  id: randomUUID(),
  createdAt: new Date().toISOString(),
  type,
  payload,
  sessionId,
});
const interrupted = (id: string) => ({
  v: 1,
  id,
  status: "rejected",
  error: {
    code: "ASYNC_INTERRUPTED",
    message:
      "The accepted operation was interrupted before its completion was saved.",
    retryable: false,
  },
});
const results = (host: Awaited<ReturnType<typeof startHost>>, stream: string) =>
  host.store.replay(stream, 0).filter((e: Row) => e.type === "command.result");

it("stranded accepted async completions recover once as durable interrupted results", async () => {
  const fixture = await browserHost();
  await fixture.host.close();
  const sessionId = fixture.session.id;
  const stream = `session:${sessionId}`;
  const options = {
    root: fixture.data,
    assets: resolve("dist/ui"),
    helper: resolve("dist/native/suri-helper"),
    simulated: true,
    validation: true,
    directoryHome: fixture.workspace,
  };
  const validateRoot = await mkdtemp(join(tmpdir(), "suri-cp2-validate-"));
  const runtimeId = randomUUID();
  const seed = new Storage(validateRoot);
  seed.put("runtime", {
    id: runtimeId,
    version: "fixture",
    executable: "/fixture",
    identity: "fixture",
    status: "candidate",
    revision: 1,
  });
  seed.close();
  const validateOptions = {
    root: validateRoot,
    assets: resolve("dist/ui"),
    helper: resolve("dist/native/suri-helper"),
    runsFile: join(validateRoot, "validator-runs.log"),
  };
  const out = (name: string) => join(fixture.root, `${name}.json`);
  const warm = envelope("session.resume", sessionId);
  try {
    const sessions = (async () => {
      const resume = await crash(
        "resume",
        options,
        [envelope("session.resume", sessionId)],
        out("resume"),
      );
      const submit = await crash(
        "submit",
        options,
        [
          warm,
          envelope("run.submit", sessionId, {
            text: "stranded prompt",
            mode: "prompt",
            attachmentIds: [],
          }),
        ],
        out("submit"),
      );
      return [resume, submit];
    })();
    const [[resume, submit], validate] = await Promise.all([
      sessions,
      crash(
        "validate",
        validateOptions,
        [envelope("runtime.validate", undefined, { runtimeId })],
        out("validate"),
      ),
    ]);
    expect(submit.type).toBe("run.submit");
    const heads: number[] = [];
    // Two restarts: the first recovers, the second must change nothing.
    for (const restart of [1, 2]) {
      const host = await startHost(options);
      const catalogHost = await startHost(validateOptions);
      try {
        for (const [h, c, s] of [
          [host, resume, stream],
          [host, submit, stream],
          [catalogHost, validate, "catalog"],
        ] as const) {
          const expected = interrupted(c.id);
          expect(h.store.commandReceipt(c.id)).toEqual(expected);
          // Same-ID poll returns the durable rejection; nothing re-executes.
          expect(await h.execute(c as any, "poller")).toEqual(expected);
          const events = results(h, s).filter((e) => e.payload.id === c.id);
          expect(events.map((e) => e.payload)).toEqual([expected]);
        }
        expect(host.store.commandReceipt(warm.id)).toMatchObject({
          status: "completed",
        });
        expect(host.children.size).toBe(0);
        expect(catalogHost.children.size).toBe(0);
        expect(
          (await readFile(validateOptions.runsFile, "utf8")).trim().split("\n"),
        ).toEqual(["validate"]);
        heads.push(host.store.head(stream), catalogHost.store.head("catalog"));
        if (restart === 2) expect(heads.slice(2)).toEqual(heads.slice(0, 2));
      } finally {
        await host.close();
        await catalogHost.close();
      }
    }
  } finally {
    await rm(validateRoot, { recursive: true, force: true });
    await rm(fixture.root, { recursive: true, force: true });
  }
}, 120_000);
