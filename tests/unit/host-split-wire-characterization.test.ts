import { afterEach, beforeEach, expect, it } from "vitest";
import {
  fixtureHashes,
  installSeams,
  seedSession,
  removeSeams,
  wireFixture,
  type WireFixture,
} from "../support/host-wire-capture.js";

let f: WireFixture;
beforeEach(async () => {
  installSeams();
  f = await wireFixture();
});
afterEach(async () => {
  await f.cleanup();
  removeSeams();
});

it("pins startup, control-socket and HTTP handshake bytes", async () => {
  const t: string[] = [];
  const ctl = async (label: string, line: string) =>
    t.push(`ctl ${label}: ${JSON.stringify(f.mask(await f.controlRaw(line)))}`);
  await ctl("health", '{"type":"health"}\n');
  await ctl("bootstrap", '{"type":"bootstrap"}\n');
  await ctl(
    "bootstrap clientId",
    '{"type":"bootstrap","clientId":"11111111-2222-3333-4444-555555555555"}\n',
  );
  await ctl(
    "bootstrap bad clientId",
    '{"type":"bootstrap","clientId":"nope"}\n',
  );
  await ctl("unknown", '{"type":"nope"}\n');
  await ctl("malformed", "not json\n");
  await ctl(
    "grant directory",
    JSON.stringify({ type: "grant", kind: "directory", path: f.workspace }) +
      "\n",
  );
  await ctl("legacy admit w/o modern", '{"type":"legacy-migrate-admit"}\n');
  await ctl("updates-status", '{"type":"updates-status"}\n');
  expect(f.commonHeaders).toMatchInlineSnapshot(`
    [
      "X-Content-Type-Options: nosniff",
      "Referrer-Policy: no-referrer",
      "Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob:; connect-src 'self'; font-src 'self'; frame-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    ]
  `);
  t.push(
    `endpoint ${f.mask(JSON.stringify(f.host.socketPath))} ${f.mask(f.host.origin)}`,
  );

  t.push(f.render(await f.http("/")));
  t.push(f.render(await f.http("/index.html")));
  t.push(f.render(await f.http("/missing.js")));
  t.push(f.render(await f.http("/%2e%2e/etc/passwd")));
  t.push(f.render(await f.http("/", { method: "PUT" })));
  t.push(f.render(await f.http("/", { headers: { Host: "evil.invalid" } })));
  t.push(
    f.render(
      await f.http("/", { headers: { Origin: "https://evil.invalid" } }),
    ),
  );
  t.push(f.render(await f.http("/v1/client")));
  t.push(
    f.render(await f.http("/v1/bootstrap", { method: "POST", body: "{}" })),
  );
  t.push(
    f.render(
      await f.http("/v1/bootstrap", {
        method: "POST",
        headers: { Origin: f.host.origin },
        body: "{bad",
      }),
    ),
  );
  t.push(
    f.render(
      await f.http("/v1/bootstrap", {
        method: "POST",
        headers: { Origin: f.host.origin },
        body: '{"nonce":"stale"}',
      }),
    ),
  );

  const session = await f.login();
  t.push(f.render(session.raw));
  // The control nonce minted earlier ("ctl bootstrap") was never redeemed: first use wins, replay fails.
  for (let attempt = 0; attempt < 2; attempt++)
    t.push(
      f.render(
        await f.http("/v1/bootstrap", {
          method: "POST",
          headers: { Origin: f.host.origin },
          body: JSON.stringify({ nonce: "03".repeat(32) }),
        }),
      ),
    );
  const authed = { Cookie: session.cookie };
  t.push(f.render(await f.http("/v1/client", { headers: authed })));
  t.push(f.render(await f.http("/v1/nope", { headers: authed })));
  t.push(
    f.render(
      await f.http("/v1/nope", {
        method: "POST",
        headers: { ...authed, Origin: f.host.origin },
      }),
    ),
  );
  t.push(
    f.render(
      await f.http("/v1/nope", {
        method: "POST",
        headers: {
          ...authed,
          Origin: f.host.origin,
          "X-Suri-Csrf": session.csrf,
        },
      }),
    ),
  );
  t.push(
    f.render(
      await f.http("/v1/commands", {
        method: "POST",
        headers: {
          ...authed,
          Origin: f.host.origin,
          "X-Suri-Csrf": session.csrf,
        },
        body: "{bad",
      }),
    ),
  );
  t.push(f.render(await f.post(session, "/v1/commands", { v: 2 })));
  t.push(
    f.render(
      await f.post(session, "/v1/commands", f.envelope("no.such.command")),
    ),
  );
  t.push(f.render(await f.http("/v1/assets/missing", { headers: authed })));
  t.push(f.render(await f.http("/v1/ui-selection", { headers: authed })));
  t.push(
    f.render(
      await f.http("/v1/restart-handoff", {
        method: "POST",
        headers: { Origin: f.host.origin },
        body: "{}",
      }),
    ),
  );
  expect(t).toMatchInlineSnapshot(`
    [
      "ctl health: "{\\"product\\":\\"suri-pi\\",\\"productVersion\\":\\"0.1.0\\",\\"protocol\\":1,\\"uiContract\\":1,\\"storageSchema\\":1,\\"capabilities\\":[\\"local-browser\\",\\"authenticated-bootstrap\\"],\\"hostBuildId\\":null,\\"uiBuildId\\":null,\\"adapterBuildId\\":null,\\"hostPresent\\":true,\\"pid\\":\\"<PID>\\",\\"instanceId\\":\\"00000000-0000-4000-8000-000000000002\\",\\"lifecycle\\":\\"running\\",\\"shutdownStage\\":\\"running\\",\\"sessions\\":0,\\"activeWork\\":0,\\"work\\":{\\"count\\":0,\\"blockers\\":[]}}\\n"",
      "ctl bootstrap: "{\\"origin\\":\\"http://127.0.0.1:<PORT>\\",\\"nonce\\":\\"0303030303030303030303030303030303030303030303030303030303030303\\"}\\n"",
      "ctl bootstrap clientId: "{\\"origin\\":\\"http://127.0.0.1:<PORT>\\",\\"nonce\\":\\"0404040404040404040404040404040404040404040404040404040404040404\\"}\\n"",
      "ctl bootstrap bad clientId: "{\\"origin\\":\\"http://127.0.0.1:<PORT>\\",\\"nonce\\":\\"0505050505050505050505050505050505050505050505050505050505050505\\"}\\n"",
      "ctl unknown: "{\\"error\\":\\"UNKNOWN_CONTROL\\"}\\n"",
      "ctl malformed: """,
      "ctl grant directory: "{\\"grantId\\":\\"00000000-0000-4000-8000-000000000006\\"}\\n"",
      "ctl legacy admit w/o modern: "{\\"error\\":\\"HOST_IDENTITY_CHANGED\\"}\\n"",
      "ctl updates-status: "{\\"schema\\":1,\\"capability\\":\\"updates-status-v1\\",\\"revision\\":0,\\"profileId\\":\\"00000000-0000-4000-8000-000000000007\\",\\"channel\\":\\"packaged\\",\\"runningHost\\":{\\"buildId\\":null,\\"adapterId\\":null,\\"instanceId\\":\\"00000000-0000-4000-8000-000000000002\\",\\"epoch\\":\\"00000000-0000-4000-8000-000000000001\\",\\"uiContract\\":1,\\"provenance\\":\\"legacy-unverified\\"},\\"ui\\":{\\"activeId\\":null,\\"previousKnownGoodId\\":null,\\"fallbackId\\":null},\\"activationSupported\\":false,\\"associationRequired\\":true,\\"available\\":{\\"ui\\":{\\"state\\":\\"none\\"},\\"host\\":{\\"state\\":\\"none\\"}}}\\n"",
      "endpoint "<ROOT>/run/control.sock" http://127.0.0.1:<PORT>",
      "HTTP 200
    <common headers>
    Content-Type: text/html
    Cache-Control: no-store
    Date: <HTTP-DATE>
    Connection: close
    Content-Length: 35

    <!doctype html><p>wire fixture</p>
    ",
      "HTTP 200
    <common headers>
    Content-Type: text/html
    Cache-Control: no-store
    Date: <HTTP-DATE>
    Connection: close
    Content-Length: 35

    <!doctype html><p>wire fixture</p>
    ",
      "HTTP 404
    <common headers>
    Content-Type: application/json
    Date: <HTTP-DATE>
    Connection: close
    Transfer-Encoding: chunked

    {"v":1,"id":"","status":"rejected","error":{"code":"NOT_FOUND","message":"Static asset not found.","retryable":false}}",
      "HTTP 404
    <common headers>
    Content-Type: application/json
    Date: <HTTP-DATE>
    Connection: close
    Transfer-Encoding: chunked

    {"v":1,"id":"","status":"rejected","error":{"code":"NOT_FOUND","message":"Static asset not found.","retryable":false}}",
      "HTTP 400
    <common headers>
    Content-Type: application/json
    Date: <HTTP-DATE>
    Connection: close
    Transfer-Encoding: chunked

    {"v":1,"id":"","status":"rejected","error":{"code":"VALIDATION","message":"Method not allowed.","retryable":false}}",
      "HTTP 401
    <common headers>
    Content-Type: application/json
    Date: <HTTP-DATE>
    Connection: close
    Transfer-Encoding: chunked

    {"v":1,"id":"","status":"rejected","error":{"code":"UNAUTHORIZED","message":"Invalid host.","retryable":false}}",
      "HTTP 401
    <common headers>
    Content-Type: application/json
    Date: <HTTP-DATE>
    Connection: close
    Transfer-Encoding: chunked

    {"v":1,"id":"","status":"rejected","error":{"code":"UNAUTHORIZED","message":"Cross-origin request rejected.","retryable":false}}",
      "HTTP 401
    <common headers>
    Content-Type: application/json
    Date: <HTTP-DATE>
    Connection: close
    Transfer-Encoding: chunked

    {"v":1,"id":"","status":"rejected","error":{"code":"UNAUTHORIZED","message":"Open Suri through its native app or local CLI.","retryable":false}}",
      "HTTP 401
    <common headers>
    Content-Type: application/json
    Date: <HTTP-DATE>
    Connection: close
    Transfer-Encoding: chunked

    {"v":1,"id":"","status":"rejected","error":{"code":"UNAUTHORIZED","message":"Origin required.","retryable":false}}",
      "HTTP 400
    <common headers>
    Content-Type: application/json
    Date: <HTTP-DATE>
    Connection: close
    Transfer-Encoding: chunked

    {"v":1,"id":"","status":"rejected","error":{"code":"INTERNAL","message":"The operation could not be completed.","retryable":false}}",
      "HTTP 401
    <common headers>
    Content-Type: application/json
    Date: <HTTP-DATE>
    Connection: close
    Transfer-Encoding: chunked

    {"v":1,"id":"","status":"rejected","error":{"code":"UNAUTHORIZED","message":"Bootstrap expired or already used.","retryable":false}}",
      "HTTP 200
    <common headers>
    Set-Cookie: suri_<PORT>=0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800
    Content-Type: application/json
    Date: <HTTP-DATE>
    Connection: close
    Transfer-Encoding: chunked

    {"v":1,"csrf":"0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b","clientId":"00000000-0000-4000-8000-000000000012"}",
      "HTTP 200
    <common headers>
    Set-Cookie: suri_<PORT>=0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d0d; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800
    Content-Type: application/json
    Date: <HTTP-DATE>
    Connection: close
    Transfer-Encoding: chunked

    {"v":1,"csrf":"0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e","clientId":"00000000-0000-4000-8000-000000000015"}",
      "HTTP 401
    <common headers>
    Content-Type: application/json
    Date: <HTTP-DATE>
    Connection: close
    Transfer-Encoding: chunked

    {"v":1,"id":"","status":"rejected","error":{"code":"UNAUTHORIZED","message":"Bootstrap expired or already used.","retryable":false}}",
      "HTTP 200
    <common headers>
    Set-Cookie: suri_<PORT>=0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800
    Content-Type: application/json
    Date: <HTTP-DATE>
    Connection: close
    Transfer-Encoding: chunked

    {"csrf":"0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b","clientId":"00000000-0000-4000-8000-000000000012"}",
      "HTTP 401
    <common headers>
    Content-Type: application/json
    Date: <HTTP-DATE>
    Connection: close
    Transfer-Encoding: chunked

    {"v":1,"id":"","status":"rejected","error":{"code":"UNAUTHORIZED","message":"Authenticated same-origin command required.","retryable":false}}",
      "HTTP 401
    <common headers>
    Content-Type: application/json
    Date: <HTTP-DATE>
    Connection: close
    Transfer-Encoding: chunked

    {"v":1,"id":"","status":"rejected","error":{"code":"UNAUTHORIZED","message":"Authenticated same-origin command required.","retryable":false}}",
      "HTTP 400
    <common headers>
    Set-Cookie: suri_<PORT>=0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800
    Content-Type: application/json
    Date: <HTTP-DATE>
    Connection: close
    Transfer-Encoding: chunked

    {"v":1,"id":"","status":"rejected","error":{"code":"NOT_FOUND","message":"Endpoint not found.","retryable":false}}",
      "HTTP 400
    <common headers>
    Set-Cookie: suri_<PORT>=0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800
    Content-Type: application/json
    Date: <HTTP-DATE>
    Connection: close
    Transfer-Encoding: chunked

    {"v":1,"id":"","status":"rejected","error":{"code":"INTERNAL","message":"The operation could not be completed.","retryable":false}}",
      "HTTP 400
    <common headers>
    Set-Cookie: suri_<PORT>=0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800
    Content-Type: application/json
    Date: <HTTP-DATE>
    Connection: close
    Transfer-Encoding: chunked

    {"v":1,"id":"","status":"rejected","error":{"code":"VALIDATION","message":"Invalid command envelope.","retryable":false}}",
      "HTTP 200
    <common headers>
    Set-Cookie: suri_<PORT>=0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800
    Content-Type: application/json
    Date: <HTTP-DATE>
    Connection: close
    Transfer-Encoding: chunked

    {"v":1,"id":"00000000-0000-4000-8000-000000000016","status":"rejected","error":{"code":"UNKNOWN_COMMAND","message":"This operation is not implemented.","retryable":false}}",
      "HTTP 400
    <common headers>
    Set-Cookie: suri_<PORT>=0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800
    Content-Type: application/json
    Date: <HTTP-DATE>
    Connection: close
    Transfer-Encoding: chunked

    {"v":1,"id":"","status":"rejected","error":{"code":"NOT_FOUND","message":"asset was not found.","retryable":false}}",
      "HTTP 401
    <common headers>
    Content-Type: application/json
    Date: <HTTP-DATE>
    Connection: close
    Transfer-Encoding: chunked

    {"v":1,"id":"","status":"rejected","error":{"code":"UNAUTHORIZED","message":"Authenticated same-origin command required.","retryable":false}}",
      "HTTP 401
    <common headers>
    Content-Type: application/json
    Date: <HTTP-DATE>
    Connection: close
    Transfer-Encoding: chunked

    {"v":1,"id":"","status":"rejected","error":{"code":"UNAUTHORIZED","message":"Open Suri through its native app or local CLI.","retryable":false}}",
    ]
  `);
});

async function seed(session: Awaited<ReturnType<WireFixture["login"]>>) {
  const t: string[] = [];
  const cmd = async (
    label: string,
    type: string,
    payload: Record<string, unknown> = {},
    extra: Record<string, unknown> = {},
  ) => {
    const raw = await f.post(
      session,
      "/v1/commands",
      f.envelope(type, payload, extra),
    );
    t.push(`${label} => ${f.render(raw)}`);
    return JSON.parse(raw.body);
  };
  return { t, cmd };
}

it("pins command receipts over HTTP: seeding, replay, rejection and id reuse", async () => {
  const session = await f.login();
  const { t, cmd } = await seed(session);
  await cmd("host.get", "host.get");
  const project = (
    await cmd("project.add", "project.add", {
      directoryGrantId: await f.grant("directory", f.workspace),
    })
  ).result;
  const runtime = (
    await cmd("runtime.register", "runtime.register", {
      executableGrantId: await f.grant("executable", f.executable),
      expectedVersion: "0.85.1",
    })
  ).result;
  const created = (
    await cmd("session.create", "session.create", {
      workspaceId: (f.host.store.list("workspace") as any[])[0].id,
      runtimeId: runtime.id,
    })
  ).result;
  await cmd(
    "session.rename",
    "session.rename",
    { name: "Wire fixture" },
    { sessionId: created.id, expectedRevision: created.revision },
  );
  const save = f.envelope(
    "draft.save",
    { text: "keep", attachmentIds: [] },
    { sessionId: created.id, expectedRevision: 0 },
  );
  for (const label of ["draft.save first", "draft.save replay"])
    t.push(
      `${label} => ${f.render(await f.post(session, "/v1/commands", save))}`,
    );
  t.push(
    `draft.save reused id => ${f.render(await f.post(session, "/v1/commands", { ...save, payload: { text: "changed", attachmentIds: [] } }))}`,
  );
  await cmd(
    "draft.save stale",
    "draft.save",
    { text: "stale", attachmentIds: [] },
    { sessionId: created.id, expectedRevision: 0 },
  );
  await cmd("section.create", "section.create", { label: "Wire section" });
  await cmd("catalog.get", "catalog.get");
  await cmd(
    "session.rename invalid",
    "session.rename",
    {},
    { sessionId: created.id, expectedRevision: 1 },
  );
  await cmd(
    "session missing",
    "session.context",
    {},
    { sessionId: "00000000-0000-4000-8000-0000000000ff" },
  );
  void project;
  expect(t).toMatchInlineSnapshot(`
    [
      "host.get => HTTP 200
    <common headers>
    Set-Cookie: suri_<PORT>=0404040404040404040404040404040404040404040404040404040404040404; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800
    Content-Type: application/json
    Date: <HTTP-DATE>
    Connection: close
    Transfer-Encoding: chunked

    {"v":1,"id":"00000000-0000-4000-8000-000000000007","status":"completed","result":{"protocol":1,"build":"0.1.0","hostBuildId":null,"adapterBuildId":null,"hostEpoch":"00000000-0000-4000-8000-000000000001","capabilities":["sessions","files","git","terminal"],"limits":{"sessions":4,"terminals":4},"validation":true,"runtimeMode":"simulated"}}",
      "project.add => HTTP 200
    <common headers>
    Set-Cookie: suri_<PORT>=0404040404040404040404040404040404040404040404040404040404040404; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800
    Content-Type: application/json
    Date: <HTTP-DATE>
    Connection: close
    Transfer-Encoding: chunked

    {"v":1,"id":"00000000-0000-4000-8000-000000000009","status":"completed","result":{"id":"00000000-0000-4000-8000-000000000010","root":"<WORKSPACE>","label":"workspace","revision":1}}",
      "runtime.register => HTTP 200
    <common headers>
    Set-Cookie: suri_<PORT>=0404040404040404040404040404040404040404040404040404040404040404; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800
    Content-Type: application/json
    Date: <HTTP-DATE>
    Connection: close
    Transfer-Encoding: chunked

    {"v":1,"id":"00000000-0000-4000-8000-000000000013","status":"completed","result":{"id":"00000000-0000-4000-8000-000000000014","executable":"<TMP>/fake-pi/dist/cli.mjs","version":"0.85.1","identity":"21d8a19cf1cd8b3c473cd8524ba7257fb218ed143f26d068b897a5d1ea2b8e44","status":"candidate","adapterVersion":1,"revision":1}}",
      "session.create => HTTP 200
    <common headers>
    Set-Cookie: suri_<PORT>=0404040404040404040404040404040404040404040404040404040404040404; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800
    Content-Type: application/json
    Date: <HTTP-DATE>
    Connection: close
    Transfer-Encoding: chunked

    {"v":1,"id":"00000000-0000-4000-8000-000000000015","status":"completed","result":{"id":"00000000-0000-4000-8000-000000000016","workspaceId":"00000000-0000-4000-8000-000000000011","runtimeId":"00000000-0000-4000-8000-000000000014","name":"New session","nameSource":"default","archived":false,"revision":1,"createdAt":"2026-01-02T03:04:05.000Z","updatedAt":"2026-01-02T03:04:05.000Z"}}",
      "session.rename => HTTP 200
    <common headers>
    Set-Cookie: suri_<PORT>=0404040404040404040404040404040404040404040404040404040404040404; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800
    Content-Type: application/json
    Date: <HTTP-DATE>
    Connection: close
    Transfer-Encoding: chunked

    {"v":1,"id":"00000000-0000-4000-8000-000000000017","status":"completed","result":{"id":"00000000-0000-4000-8000-000000000016","workspaceId":"00000000-0000-4000-8000-000000000011","runtimeId":"00000000-0000-4000-8000-000000000014","name":"Wire fixture","nameSource":"manual","archived":false,"revision":2,"createdAt":"2026-01-02T03:04:05.000Z","updatedAt":"2026-01-02T03:04:05.000Z"}}",
      "draft.save first => HTTP 200
    <common headers>
    Set-Cookie: suri_<PORT>=0404040404040404040404040404040404040404040404040404040404040404; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800
    Content-Type: application/json
    Date: <HTTP-DATE>
    Connection: close
    Transfer-Encoding: chunked

    {"v":1,"id":"00000000-0000-4000-8000-000000000018","status":"completed","result":{"id":"00000000-0000-4000-8000-000000000016:00000000-0000-4000-8000-000000000006","sessionId":"00000000-0000-4000-8000-000000000016","clientId":"00000000-0000-4000-8000-000000000006","text":"keep","attachmentIds":[],"revision":1,"updatedAt":"2026-01-02T03:04:05.000Z"}}",
      "draft.save replay => HTTP 200
    <common headers>
    Set-Cookie: suri_<PORT>=0404040404040404040404040404040404040404040404040404040404040404; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800
    Content-Type: application/json
    Date: <HTTP-DATE>
    Connection: close
    Transfer-Encoding: chunked

    {"v":1,"id":"00000000-0000-4000-8000-000000000018","status":"completed","result":{"id":"00000000-0000-4000-8000-000000000016:00000000-0000-4000-8000-000000000006","sessionId":"00000000-0000-4000-8000-000000000016","clientId":"00000000-0000-4000-8000-000000000006","text":"keep","attachmentIds":[],"revision":1,"updatedAt":"2026-01-02T03:04:05.000Z"}}",
      "draft.save reused id => HTTP 400
    <common headers>
    Set-Cookie: suri_<PORT>=0404040404040404040404040404040404040404040404040404040404040404; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800
    Content-Type: application/json
    Date: <HTTP-DATE>
    Connection: close
    Transfer-Encoding: chunked

    {"v":1,"id":"","status":"rejected","error":{"code":"CONFLICT","message":"Request id was reused with different content.","retryable":false}}",
      "draft.save stale => HTTP 200
    <common headers>
    Set-Cookie: suri_<PORT>=0404040404040404040404040404040404040404040404040404040404040404; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800
    Content-Type: application/json
    Date: <HTTP-DATE>
    Connection: close
    Transfer-Encoding: chunked

    {"v":1,"id":"00000000-0000-4000-8000-000000000019","status":"rejected","error":{"code":"CONFLICT","message":"The draft changed in another window.","retryable":false}}",
      "section.create => HTTP 200
    <common headers>
    Set-Cookie: suri_<PORT>=0404040404040404040404040404040404040404040404040404040404040404; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800
    Content-Type: application/json
    Date: <HTTP-DATE>
    Connection: close
    Transfer-Encoding: chunked

    {"v":1,"id":"00000000-0000-4000-8000-000000000020","status":"completed","result":{"id":"00000000-0000-4000-8000-000000000021","label":"Wire section","order":0,"collapsed":false,"revision":1}}",
      "catalog.get => HTTP 200
    <common headers>
    Set-Cookie: suri_<PORT>=0404040404040404040404040404040404040404040404040404040404040404; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800
    Content-Type: application/json
    Date: <HTTP-DATE>
    Connection: close
    Transfer-Encoding: chunked

    {"v":1,"id":"00000000-0000-4000-8000-000000000022","status":"completed","result":{"runtimeMode":"simulated","projects":[{"id":"00000000-0000-4000-8000-000000000010","root":"<WORKSPACE>","label":"workspace","revision":1}],"workspaces":[{"id":"00000000-0000-4000-8000-000000000011","projectId":"00000000-0000-4000-8000-000000000010","root":"<WORKSPACE>","label":"workspace","revision":1}],"sections":[{"id":"00000000-0000-4000-8000-000000000021","label":"Wire section","order":0,"collapsed":false,"revision":1}],"sessions":[{"id":"00000000-0000-4000-8000-000000000016","workspaceId":"00000000-0000-4000-8000-000000000011","runtimeId":"00000000-0000-4000-8000-000000000014","name":"Wire fixture","nameSource":"manual","archived":false,"revision":2,"createdAt":"2026-01-02T03:04:05.000Z","updatedAt":"2026-01-02T03:04:05.000Z","hasConversation":false,"phase":"idle","seq":0,"unread":false}],"runtimes":[{"id":"00000000-0000-4000-8000-000000000014","version":"0.85.1","identity":"21d8a19cf1cd8b3c473cd8524ba7257fb218ed143f26d068b897a5d1ea2b8e44","status":"candidate","adapterVersion":1,"revision":1}]}}",
      "session.rename invalid => HTTP 200
    <common headers>
    Set-Cookie: suri_<PORT>=0404040404040404040404040404040404040404040404040404040404040404; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800
    Content-Type: application/json
    Date: <HTTP-DATE>
    Connection: close
    Transfer-Encoding: chunked

    {"v":1,"id":"00000000-0000-4000-8000-000000000023","status":"rejected","error":{"code":"VALIDATION","message":"Invalid name.","retryable":false}}",
      "session missing => HTTP 200
    <common headers>
    Set-Cookie: suri_<PORT>=0404040404040404040404040404040404040404040404040404040404040404; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800
    Content-Type: application/json
    Date: <HTTP-DATE>
    Connection: close
    Transfer-Encoding: chunked

    {"v":1,"id":"00000000-0000-4000-8000-000000000024","status":"rejected","error":{"code":"NOT_FOUND","message":"session was not found.","retryable":false}}",
    ]
  `);
});

const seededSession = (login: Awaited<ReturnType<WireFixture["login"]>>) =>
  seedSession(f, login);

it("pins WebSocket snapshot, live, replay and rejection frames", async () => {
  const login = await f.login();
  const { cmd, session } = await seededSession(login);
  const ws = await f.connect(login);
  const t: string[] = [];
  let seen = 0;
  const step = async (label: string, frame: unknown, count: number) => {
    ws.send(frame);
    await ws.until(() => ws.frames.length >= seen + count);
    // Count-0 steps are ordered by the following step on the same socket.
    t.push(
      `${label}\n${ws.frames
        .slice(seen, seen + count)
        .map(f.mask)
        .join("\n")}`,
    );
    seen += count;
  };
  const epoch = f.host.store.epoch;
  await step(
    "subscribe catalog",
    { v: 1, type: "subscribe", streamId: "catalog" },
    1,
  );
  await step(
    "subscribe session",
    { v: 1, type: "subscribe", streamId: `session:${session.id}` },
    1,
  );
  const live = ws.until(() => ws.frames.length >= seen + 1);
  await cmd("section.create", { label: "Live" });
  await live;
  t.push(`live catalog event\n${f.mask(ws.frames[seen++])}`);
  const head = f.host.store.head("catalog");
  ws.send({
    v: 1,
    type: "subscribe",
    streamId: "catalog",
    afterSeq: head,
    hostEpoch: epoch,
  });
  await step(
    "resume at head (no frame) then replay from head-1",
    {
      v: 1,
      type: "subscribe",
      streamId: "catalog",
      afterSeq: head - 1,
      hostEpoch: epoch,
    },
    1,
  );
  await step(
    "replay from 0 (incomplete or complete)",
    {
      v: 1,
      type: "subscribe",
      streamId: "catalog",
      afterSeq: 0,
      hostEpoch: epoch,
    },
    head,
  );
  await step(
    "wrong epoch falls back to snapshot",
    {
      v: 1,
      type: "subscribe",
      streamId: "catalog",
      afterSeq: 1,
      hostEpoch: "other",
    },
    1,
  );
  ws.send({ v: 1, type: "unsubscribe", streamId: "catalog" });
  await cmd("section.create", { label: "Unseen by catalog" });
  await cmd(
    "draft.save",
    { text: "x", attachmentIds: [] },
    { sessionId: session.id, expectedRevision: 0 },
  );
  // Barrier on the same ordered socket: publishes above were sent synchronously
  // before their HTTP receipts, so any frame for them would precede this snapshot.
  await step(
    "no catalog frames after unsubscribe; barrier snapshot",
    { v: 1, type: "subscribe", streamId: `session:${session.id}` },
    1,
  );
  const closed = [];
  for (const bad of [
    { v: 1, type: "subscribe", streamId: "bogus" },
    {
      v: 1,
      type: "subscribe",
      streamId: "session:00000000-0000-4000-8000-0000000000ff",
    },
    "not-json",
    { v: 2, type: "subscribe", streamId: "catalog" },
  ]) {
    const socket = await f.connect(login);
    socket.socket.send(typeof bad === "string" ? bad : JSON.stringify(bad));
    closed.push(await socket.closed);
  }
  t.push(`bad subscriptions close codes ${JSON.stringify(closed)}`);
  expect(t).toMatchInlineSnapshot(`
    [
      "subscribe catalog
    {"v":1,"type":"snapshot","streamId":"catalog","seq":2,"hostEpoch":"00000000-0000-4000-8000-000000000001","payload":{"runtimeMode":"simulated","projects":[{"id":"00000000-0000-4000-8000-000000000009","root":"<WORKSPACE>","label":"workspace","revision":1}],"workspaces":[{"id":"00000000-0000-4000-8000-000000000010","projectId":"00000000-0000-4000-8000-000000000009","root":"<WORKSPACE>","label":"workspace","revision":1}],"sections":[],"sessions":[{"id":"00000000-0000-4000-8000-000000000015","workspaceId":"00000000-0000-4000-8000-000000000010","runtimeId":"00000000-0000-4000-8000-000000000013","name":"New session","nameSource":"default","archived":false,"revision":1,"createdAt":"2026-01-02T03:04:05.000Z","updatedAt":"2026-01-02T03:04:05.000Z","hasConversation":false,"phase":"idle","seq":0,"unread":false}],"runtimes":[{"id":"00000000-0000-4000-8000-000000000013","version":"0.85.1","identity":"21d8a19cf1cd8b3c473cd8524ba7257fb218ed143f26d068b897a5d1ea2b8e44","status":"candidate","adapterVersion":1,"revision":1}],"seq":2}}",
      "subscribe session
    {"v":1,"type":"snapshot","streamId":"session:00000000-0000-4000-8000-000000000015","seq":0,"hostEpoch":"00000000-0000-4000-8000-000000000001","payload":{"phase":"idle","messages":[],"tools":{},"queue":[],"interactions":{},"usage":{},"notices":[],"seq":0}}",
      "live catalog event
    {"v":1,"hostEpoch":"00000000-0000-4000-8000-000000000001","streamId":"catalog","seq":3,"type":"catalog.section","at":"2026-01-02T03:04:05.000Z","payload":{"id":"00000000-0000-4000-8000-000000000017","label":"Live","order":0,"collapsed":false,"revision":1}}",
      "resume at head (no frame) then replay from head-1
    {"v":1,"hostEpoch":"00000000-0000-4000-8000-000000000001","streamId":"catalog","seq":3,"type":"catalog.section","at":"2026-01-02T03:04:05.000Z","payload":{"id":"00000000-0000-4000-8000-000000000017","label":"Live","order":0,"collapsed":false,"revision":1}}",
      "replay from 0 (incomplete or complete)
    {"v":1,"hostEpoch":"00000000-0000-4000-8000-000000000001","streamId":"catalog","seq":1,"type":"catalog.project","at":"2026-01-02T03:04:05.000Z","payload":{"id":"00000000-0000-4000-8000-000000000009","root":"<WORKSPACE>","label":"workspace","revision":1}}
    {"v":1,"hostEpoch":"00000000-0000-4000-8000-000000000001","streamId":"catalog","seq":2,"type":"catalog.session","at":"2026-01-02T03:04:05.000Z","payload":{"id":"00000000-0000-4000-8000-000000000015","workspaceId":"00000000-0000-4000-8000-000000000010","runtimeId":"00000000-0000-4000-8000-000000000013","name":"New session","nameSource":"default","archived":false,"revision":1,"createdAt":"2026-01-02T03:04:05.000Z","updatedAt":"2026-01-02T03:04:05.000Z"}}
    {"v":1,"hostEpoch":"00000000-0000-4000-8000-000000000001","streamId":"catalog","seq":3,"type":"catalog.section","at":"2026-01-02T03:04:05.000Z","payload":{"id":"00000000-0000-4000-8000-000000000017","label":"Live","order":0,"collapsed":false,"revision":1}}",
      "wrong epoch falls back to snapshot
    {"v":1,"type":"snapshot","streamId":"catalog","seq":3,"hostEpoch":"00000000-0000-4000-8000-000000000001","payload":{"runtimeMode":"simulated","projects":[{"id":"00000000-0000-4000-8000-000000000009","root":"<WORKSPACE>","label":"workspace","revision":1}],"workspaces":[{"id":"00000000-0000-4000-8000-000000000010","projectId":"00000000-0000-4000-8000-000000000009","root":"<WORKSPACE>","label":"workspace","revision":1}],"sections":[{"id":"00000000-0000-4000-8000-000000000017","label":"Live","order":0,"collapsed":false,"revision":1}],"sessions":[{"id":"00000000-0000-4000-8000-000000000015","workspaceId":"00000000-0000-4000-8000-000000000010","runtimeId":"00000000-0000-4000-8000-000000000013","name":"New session","nameSource":"default","archived":false,"revision":1,"createdAt":"2026-01-02T03:04:05.000Z","updatedAt":"2026-01-02T03:04:05.000Z","hasConversation":false,"phase":"idle","seq":0,"unread":false}],"runtimes":[{"id":"00000000-0000-4000-8000-000000000013","version":"0.85.1","identity":"21d8a19cf1cd8b3c473cd8524ba7257fb218ed143f26d068b897a5d1ea2b8e44","status":"candidate","adapterVersion":1,"revision":1}],"seq":3}}",
      "no catalog frames after unsubscribe; barrier snapshot
    {"v":1,"type":"snapshot","streamId":"session:00000000-0000-4000-8000-000000000015","seq":0,"hostEpoch":"00000000-0000-4000-8000-000000000001","payload":{"phase":"idle","messages":[],"tools":{},"queue":[],"interactions":{},"usage":{},"notices":[],"seq":0}}",
      "bad subscriptions close codes [1008,1008,1008,1008]",
    ]
  `);
});

it("pins accepted-command, runtime and terminal-adjacent frames from a fixture Pi run", async () => {
  const login = await f.login();
  const { cmd, session } = await seededSession(login);
  const ws = await f.connect(login);
  for (const streamId of [`session:${session.id}`, "catalog"]) {
    ws.send({ v: 1, type: "subscribe", streamId });
    await ws.until((frame) => frame.includes(`"streamId":"${streamId}"`));
  }
  const t: string[] = [];
  t.push(
    `resume receipt ${f.mask(JSON.stringify(await cmd("session.resume", {}, { sessionId: session.id })))}`,
  );
  await ws.until(
    (frame) =>
      frame.includes('"phase":"idle"') &&
      frame.includes("catalog.sessionPhase"),
  );
  await ws.until((frame) => frame.includes('"type":"command.result"'));
  t.push(
    `submit receipt ${f.mask(JSON.stringify(await cmd("run.submit", { mode: "prompt", text: "hello", attachmentIds: [] }, { sessionId: session.id })))}`,
  );
  await ws.until((frame) => frame.includes('"outcome":"completed"'));
  await ws.until((frame) => frame.includes('"phase":"idle","seq":9'));
  t.push(
    `reject receipt ${f.mask(JSON.stringify(await cmd("run.submit", { mode: "steer", text: "later", attachmentIds: [] }, { sessionId: session.id })))}`,
  );
  t.push(`frames\n${ws.frames.map(f.mask).join("\n")}`);
  expect(t).toMatchInlineSnapshot(`
    [
      "resume receipt {"v":1,"id":"00000000-0000-4000-8000-000000000016","status":"accepted"}",
      "submit receipt {"v":1,"id":"00000000-0000-4000-8000-000000000021","status":"accepted"}",
      "reject receipt {"v":1,"id":"00000000-0000-4000-8000-000000000025","status":"rejected","error":{"code":"VALIDATION","message":"Queue delivery requires an active run.","retryable":false}}",
      "frames
    {"v":1,"type":"snapshot","streamId":"session:00000000-0000-4000-8000-000000000015","seq":0,"hostEpoch":"00000000-0000-4000-8000-000000000001","payload":{"phase":"idle","messages":[],"tools":{},"queue":[],"interactions":{},"usage":{},"notices":[],"seq":0}}
    {"v":1,"type":"snapshot","streamId":"catalog","seq":2,"hostEpoch":"00000000-0000-4000-8000-000000000001","payload":{"runtimeMode":"simulated","projects":[{"id":"00000000-0000-4000-8000-000000000009","root":"<WORKSPACE>","label":"workspace","revision":1}],"workspaces":[{"id":"00000000-0000-4000-8000-000000000010","projectId":"00000000-0000-4000-8000-000000000009","root":"<WORKSPACE>","label":"workspace","revision":1}],"sections":[],"sessions":[{"id":"00000000-0000-4000-8000-000000000015","workspaceId":"00000000-0000-4000-8000-000000000010","runtimeId":"00000000-0000-4000-8000-000000000013","name":"New session","nameSource":"default","archived":false,"revision":1,"createdAt":"2026-01-02T03:04:05.000Z","updatedAt":"2026-01-02T03:04:05.000Z","hasConversation":false,"phase":"idle","seq":0,"unread":false}],"runtimes":[{"id":"00000000-0000-4000-8000-000000000013","version":"0.85.1","identity":"21d8a19cf1cd8b3c473cd8524ba7257fb218ed143f26d068b897a5d1ea2b8e44","status":"candidate","adapterVersion":1,"revision":1}],"seq":2}}
    {"v":1,"hostEpoch":"00000000-0000-4000-8000-000000000001","streamId":"session:00000000-0000-4000-8000-000000000015","seq":1,"type":"session.state","at":"2026-01-02T03:04:05.000Z","sessionId":"00000000-0000-4000-8000-000000000015","payload":{"phase":"starting"}}
    {"v":1,"hostEpoch":"00000000-0000-4000-8000-000000000001","streamId":"catalog","seq":3,"type":"catalog.sessionPhase","at":"2026-01-02T03:04:05.000Z","payload":{"sessionId":"00000000-0000-4000-8000-000000000015","phase":"starting","seq":1}}
    {"v":1,"hostEpoch":"00000000-0000-4000-8000-000000000001","streamId":"session:00000000-0000-4000-8000-000000000015","seq":2,"type":"session.state","at":"2026-01-02T03:04:05.000Z","sessionId":"00000000-0000-4000-8000-000000000015","payload":{"phase":"idle"}}
    {"v":1,"hostEpoch":"00000000-0000-4000-8000-000000000001","streamId":"catalog","seq":4,"type":"catalog.sessionPhase","at":"2026-01-02T03:04:05.000Z","payload":{"sessionId":"00000000-0000-4000-8000-000000000015","phase":"idle","seq":2}}
    {"v":1,"hostEpoch":"00000000-0000-4000-8000-000000000001","streamId":"session:00000000-0000-4000-8000-000000000015","seq":3,"type":"command.result","at":"2026-01-02T03:04:05.000Z","sessionId":"00000000-0000-4000-8000-000000000015","payload":{"v":1,"id":"00000000-0000-4000-8000-000000000016","status":"completed","result":{}}}
    {"v":1,"hostEpoch":"00000000-0000-4000-8000-000000000001","streamId":"catalog","seq":5,"type":"catalog.session","at":"2026-01-02T03:04:05.000Z","payload":{"id":"00000000-0000-4000-8000-000000000015","workspaceId":"00000000-0000-4000-8000-000000000010","runtimeId":"00000000-0000-4000-8000-000000000013","name":"hello","nameSource":"automatic","archived":false,"revision":2,"createdAt":"2026-01-02T03:04:05.000Z","updatedAt":"2026-01-02T03:04:05.000Z","processPid":"<PID>","piFile":"<ROOT>/runtime/00000000-0000-4000-8000-000000000015/fixture.jsonl","piSessionId":"<EXTERNAL-UUID>","model":{"provider":"synthetic","id":"fixture-model"},"thinkingLevel":"medium","hasConversation":true}}
    {"v":1,"hostEpoch":"00000000-0000-4000-8000-000000000001","streamId":"session:00000000-0000-4000-8000-000000000015","seq":4,"type":"command.result","at":"2026-01-02T03:04:05.000Z","sessionId":"00000000-0000-4000-8000-000000000015","payload":{"v":1,"id":"00000000-0000-4000-8000-000000000021","status":"completed","result":{}}}
    {"v":1,"hostEpoch":"00000000-0000-4000-8000-000000000001","streamId":"session:00000000-0000-4000-8000-000000000015","seq":5,"type":"run.state","at":"2026-01-02T03:04:05.000Z","sessionId":"00000000-0000-4000-8000-000000000015","payload":{"phase":"running"}}
    {"v":1,"hostEpoch":"00000000-0000-4000-8000-000000000001","streamId":"catalog","seq":6,"type":"catalog.sessionPhase","at":"2026-01-02T03:04:05.000Z","payload":{"sessionId":"00000000-0000-4000-8000-000000000015","phase":"running","seq":5}}
    {"v":1,"hostEpoch":"00000000-0000-4000-8000-000000000001","streamId":"session:00000000-0000-4000-8000-000000000015","seq":6,"type":"message.upsert","at":"2026-01-02T03:04:05.000Z","sessionId":"00000000-0000-4000-8000-000000000015","payload":{"messageId":"00000000-0000-4000-8000-000000000023","role":"user","blocks":[{"kind":"text","id":"00000000-0000-4000-8000-000000000023:0","text":"hello"}],"revision":1,"final":true}}
    {"v":1,"hostEpoch":"00000000-0000-4000-8000-000000000001","streamId":"session:00000000-0000-4000-8000-000000000015","seq":7,"type":"message.upsert","at":"2026-01-02T03:04:05.000Z","sessionId":"00000000-0000-4000-8000-000000000015","payload":{"messageId":"00000000-0000-4000-8000-000000000024","role":"assistant","blocks":[],"revision":1,"final":false}}
    {"v":1,"hostEpoch":"00000000-0000-4000-8000-000000000001","streamId":"session:00000000-0000-4000-8000-000000000015","seq":8,"type":"message.upsert","at":"2026-01-02T03:04:05.000Z","sessionId":"00000000-0000-4000-8000-000000000015","payload":{"messageId":"00000000-0000-4000-8000-000000000024","role":"assistant","blocks":[{"kind":"text","id":"00000000-0000-4000-8000-000000000024:0","text":"Synthetic reply. Open [hello.txt:2](hello.txt:2)."}],"revision":2,"final":true}}
    {"v":1,"hostEpoch":"00000000-0000-4000-8000-000000000001","streamId":"catalog","seq":7,"type":"catalog.sessionActivity","at":"2026-01-02T03:04:05.000Z","payload":{"sessionId":"00000000-0000-4000-8000-000000000015","seq":8}}
    {"v":1,"hostEpoch":"00000000-0000-4000-8000-000000000001","streamId":"session:00000000-0000-4000-8000-000000000015","seq":9,"type":"run.state","at":"2026-01-02T03:04:05.000Z","sessionId":"00000000-0000-4000-8000-000000000015","payload":{"phase":"idle","outcome":"completed"}}
    {"v":1,"hostEpoch":"00000000-0000-4000-8000-000000000001","streamId":"catalog","seq":8,"type":"catalog.sessionPhase","at":"2026-01-02T03:04:05.000Z","payload":{"sessionId":"00000000-0000-4000-8000-000000000015","phase":"idle","seq":9}}",
    ]
  `);
});

it("pins terminal control receipts and masked terminal stream frames", async () => {
  const login = await f.login();
  const { cmd, workspace } = await seededSession(login);
  const ws = await f.connect(login);
  const t: string[] = [];
  const created = await cmd("terminal.create", {
    workspaceId: workspace.id,
    cols: 80,
    rows: 24,
  });
  t.push(`create ${JSON.stringify(created)}`);
  const terminalId = created.result.terminalId as string;
  const stream = `terminal:${terminalId}`;
  ws.send({ v: 1, type: "subscribe", streamId: stream });
  await ws.until((frame) => frame.includes('"type":"snapshot"'));
  // The PTY buffer and cursor depend on shell start-up timing: masked like output.
  const snapshot = JSON.parse(ws.frames[0]);
  snapshot.seq = "<CURSOR>";
  snapshot.payload.cursor = "<CURSOR>";
  snapshot.payload.data = "<PTY-BYTES>";
  t.push(`subscribe ${f.mask(JSON.stringify(snapshot))}`);
  const mi = JSON.stringify;
  t.push(
    `resize ${mi(await cmd("terminal.resize", { terminalId, cols: 100, rows: 30 }))}`,
  );
  t.push(
    `input ${mi(await cmd("terminal.input", { terminalId, inputId: "i1", data: "echo wire-marker\r" }))}`,
  );
  t.push(
    `input bad ${mi(await cmd("terminal.input", { terminalId, inputId: 1, data: "x" }))}`,
  );
  t.push(
    `unknown ${mi(await cmd("terminal.attach", { terminalId: "00000000-0000-4000-8000-0000000000ff" }))}`,
  );
  // PTY bytes, cursors and exit code depend on the host shell: masked (mask 6).
  const shape = (raw: string) => {
    const frame = JSON.parse(raw);
    if (frame.type === "terminal.output") {
      frame.payload.cursor = "<CURSOR>";
      frame.payload.data = "<PTY-BYTES>";
      frame.seq = "<CURSOR>";
    }
    if (frame.type === "terminal.state") frame.payload.exitCode = "<EXIT>";
    return f.mask(JSON.stringify(frame));
  };
  await ws.until((frame) => frame.includes('"type":"terminal.output"'));
  t.push(
    `first output ${shape(ws.frames.find((frame) => frame.includes('"terminal.output"'))!)}`,
  );
  const attach = await cmd("terminal.attach", { terminalId });
  attach.result.cursor = "<CURSOR>";
  attach.result.data = "<PTY-BYTES>";
  t.push(`attach ${f.mask(mi(attach))}`);
  t.push(`close ${mi(await cmd("terminal.close", { terminalId }))}`);
  await ws.until((frame) => frame.includes('"type":"terminal.state"'));
  t.push(
    `exit ${shape(ws.frames.find((frame) => frame.includes('"terminal.state"'))!)}`,
  );
  expect(t).toMatchInlineSnapshot(`
    [
      "create {"v":1,"id":"00000000-0000-4000-8000-000000000016","status":"completed","result":{"terminalId":"00000000-0000-4000-8000-000000000017"}}",
      "subscribe {"v":1,"type":"snapshot","streamId":"terminal:00000000-0000-4000-8000-000000000017","seq":"<CURSOR>","hostEpoch":"00000000-0000-4000-8000-000000000001","payload":{"terminalId":"00000000-0000-4000-8000-000000000017","cursor":"<CURSOR>","data":"<PTY-BYTES>","phase":"running"}}",
      "resize {"v":1,"id":"00000000-0000-4000-8000-000000000018","status":"completed","result":{}}",
      "input {"v":1,"id":"00000000-0000-4000-8000-000000000019","status":"completed","result":{}}",
      "input bad {"v":1,"id":"00000000-0000-4000-8000-000000000020","status":"rejected","error":{"code":"VALIDATION","message":"Invalid terminal input.","retryable":false}}",
      "unknown {"v":1,"id":"00000000-0000-4000-8000-000000000021","status":"rejected","error":{"code":"NOT_FOUND","message":"Terminal is no longer available.","retryable":false}}",
      "first output {"v":1,"hostEpoch":"00000000-0000-4000-8000-000000000001","type":"terminal.output","payload":{"terminalId":"00000000-0000-4000-8000-000000000017","cursor":"<CURSOR>","data":"<PTY-BYTES>"},"streamId":"terminal:00000000-0000-4000-8000-000000000017","seq":"<CURSOR>"}",
      "attach {"v":1,"id":"00000000-0000-4000-8000-000000000022","status":"completed","result":{"terminalId":"00000000-0000-4000-8000-000000000017","cursor":"<CURSOR>","data":"<PTY-BYTES>","phase":"running"}}",
      "close {"v":1,"id":"00000000-0000-4000-8000-000000000023","status":"completed","result":{}}",
      "exit {"v":1,"hostEpoch":"00000000-0000-4000-8000-000000000001","type":"terminal.state","payload":{"terminalId":"00000000-0000-4000-8000-000000000017","phase":"exited","exitCode":"<EXIT>"},"streamId":"terminal:00000000-0000-4000-8000-000000000017","seq":0}",
    ]
  `);
});

it("pins control replies and health while the host drains accepted work", async () => {
  const login = await f.login();
  const { cmd, session } = await seededSession(login);
  const ws = await f.connect(login);
  ws.send({ v: 1, type: "subscribe", streamId: `session:${session.id}` });
  await ws.until((frame) => frame.includes('"type":"snapshot"'));
  await cmd("session.resume", {}, { sessionId: session.id });
  await ws.until((frame) => frame.includes('"type":"command.result"'));
  // REJECT_DELAY keeps an accepted job pending for ~500 ms (fixture Pi timer).
  const accepted = await cmd(
    "run.submit",
    { mode: "prompt", text: "REJECT_DELAY", attachmentIds: [] },
    { sessionId: session.id },
  );
  const closing = f.host.close();
  const t: string[] = [`accepted ${JSON.stringify(accepted)}`];
  let health = "";
  do {
    health = await f.controlRaw('{"type":"health"}\n');
  } while (!health.includes('"shutdownStage":"drain"'));
  t.push(`health at drain ${JSON.stringify(f.mask(health))}`);
  t.push(
    `bootstrap ${JSON.stringify(await f.controlRaw('{"type":"bootstrap"}\n'))}`,
  );
  t.push(
    `updates-status ${JSON.stringify(await f.controlRaw('{"type":"updates-status"}\n'))}`,
  );
  t.push(
    `associate-updates ${JSON.stringify(await f.controlRaw('{"type":"associate-updates"}\n'))}`,
  );
  t.push(`unknown ${JSON.stringify(await f.controlRaw('{"type":"nope"}\n'))}`);
  const late = await f.host.execute(f.envelope("project.add"), "late");
  t.push(`late execute ${JSON.stringify(late)}`);
  await closing;
  t.push(
    `control after close ${await f.controlRaw('{"type":"health"}\n').then(
      () => "answered",
      (error) => error.code,
    )}`,
  );
  expect(t).toMatchInlineSnapshot(`
    [
      "accepted {"v":1,"id":"00000000-0000-4000-8000-000000000021","status":"accepted"}",
      "health at drain "{\\"product\\":\\"suri-pi\\",\\"productVersion\\":\\"0.1.0\\",\\"protocol\\":1,\\"uiContract\\":1,\\"storageSchema\\":1,\\"capabilities\\":[\\"local-browser\\",\\"authenticated-bootstrap\\"],\\"hostBuildId\\":null,\\"uiBuildId\\":null,\\"adapterBuildId\\":null,\\"hostPresent\\":true,\\"pid\\":\\"<PID>\\",\\"instanceId\\":\\"00000000-0000-4000-8000-000000000002\\",\\"lifecycle\\":\\"stopping\\",\\"shutdownStage\\":\\"drain\\",\\"sessions\\":1,\\"activeWork\\":0,\\"work\\":{\\"count\\":0,\\"blockers\\":[]}}\\n"",
      "bootstrap "{\\"error\\":\\"HOST_STOPPING\\"}\\n"",
      "updates-status "{\\"error\\":\\"HOST_STOPPING\\"}\\n"",
      "associate-updates "{\\"error\\":\\"HOST_STOPPING\\"}\\n"",
      "unknown "{\\"error\\":\\"UNKNOWN_CONTROL\\"}\\n"",
      "late execute {"v":1,"id":"00000000-0000-4000-8000-000000000023","status":"rejected","error":{"code":"HOST_STOPPING","message":"The host is stopping and cannot accept new work.","retryable":true}}",
      "control after close ENOENT",
    ]
  `);
});

it("pins fixture Pi file hashes", async () => {
  expect(await fixtureHashes()).toMatchInlineSnapshot(`
    [
      "0.84.4/agent-end-retry-settle.expected.json 7ce1b103fb9e650df86328456884b2541e254d7d2c1697cbf06342e1bc0ee735",
      "0.84.4/agent-end-retry-settle.jsonl 35fcab236b987c2d7fa5498d09f0bc40b952c1293955adf5f256e2b1a5334594",
      "0.84.4/compaction-retry-error.expected.json 9c8104c293ac8b0d8a888d608f21ebebdd94934e9dd7e2168fcb16ac53a0ab2e",
      "0.84.4/compaction-retry-error.jsonl 542c6fa9d6c63dfdd16d4b7a0560476359047d2ae33c9b05312846ede4bf39d1",
      "0.84.4/empty-no-file-resume.expected.json c2921b1bc00bb9cd525657a3d266018b8e697cf3d2d428f63d444b2fe2064248",
      "0.84.4/empty-no-file-resume.jsonl 14295ca6fa8795565c5baa8317be3a027759f932d34c0613b2f725028174fa27",
      "0.84.4/error-abort-length.expected.json 3b440c18048fb47cde853aeb915e042efe45faf211f79d1c19355f4659fe583d",
      "0.84.4/error-abort-length.jsonl fcc5134f75fd929ea529d3bb6f3dc6d8776deb2c5ce9053e76d21f4ab9c377d8",
      "0.84.4/extension-dialog-cancel-timeout.expected.json 0c672171342829af4ca823dbd0c6191d2e3c0c77821bd4e88a48065cb46f73e0",
      "0.84.4/extension-dialog-cancel-timeout.jsonl 7f1e1b22b9286309e3030c2ab595572e9ffb1c109a99a64f9403f39a8a901c0c",
      "0.84.4/extension-widget-editor.expected.json 36f3a07e2bc646afd09f59bdc02c62c27d4baa7be426902397f091fe86a72e1a",
      "0.84.4/extension-widget-editor.jsonl cff9bb8f710c6e6aeab5939b076dfcd5c4a4fd256e80d40c2dee91bfa3e8ba57",
      "0.84.4/fork-clone-cancel.expected.json 493d2e581d5e8df0f706e3c7759289c71b09983a7084e3d15cd64fa9cc2b5c8d",
      "0.84.4/fork-clone-cancel.jsonl 3aca5218d9d7ca1d85175c74f71754250e65253e7a217035e74aa9f6b0b8a2ac",
      "0.84.4/header-cwd-import-preflight.expected.json 657ce4561ce8ea77bf0e7acee826ce2fd6a7bdd47df91a4253dd5fd5debd7c82",
      "0.84.4/header-cwd-import-preflight.jsonl 8fc9974abd353ac453bf4fa25d1fbb295c3a062c97fc027b7c532c43cc1d1ad2",
      "0.84.4/interleaved-responses.expected.json 1acf46790bc1c08a17769cf9770ab8af5de9906f12dc2b0196775f4b03e45e38",
      "0.84.4/interleaved-responses.jsonl 0dfda3a14b7383e2f8c895b88d30fb4915b46d084265cf3ad4d8a0edf4b71e89",
      "0.84.4/malformed-oversize.expected.json ff002df038e60f000dd993705f2d1bae2460d5fd07842f09b2896ea0eb1da194",
      "0.84.4/malformed-oversize.jsonl 23e6910e3c61f4f5a43426da10674058cddd4727b6ad0ba2101ca34288f9a55c",
      "0.84.4/model-catalog-redaction.expected.json cb206e32b633cd3a5ea1276c6f0693c7f050fb1801dc125e943b4ae6d2c407db",
      "0.84.4/model-catalog-redaction.jsonl 75cc8b7209fd76f2ad1b68020e5ad4093da0d386b6f215256de985320b9b9244",
      "0.84.4/no-global-settings-write.expected.json 295d10dee42af16793a97fe85c369cfe29b21daa2fbf6d9be71e26abde860eac",
      "0.84.4/no-global-settings-write.jsonl bdb0bf86444a4d929289ba9cf43a34972faafe28d80958ee74770249b979e3ba",
      "0.84.4/process-exit-before-response.expected.json 46130ee771976c295ab13aecec0c4e1b0b70fadd3cbc9bfb494925a555d7e954",
      "0.84.4/process-exit-before-response.jsonl 69ac99f6c407454a22b00d5a0adc0dfff122b1f7246353bbfffd2f8207b8e6d9",
      "0.84.4/prompt-accepted-not-done.expected.json 5ab7275af24d8f28d25961d096c80205ce5d4fa30af9fb8adeeb4b1f8bf9caaa",
      "0.84.4/prompt-accepted-not-done.jsonl ee0db51110ec86b6a4f3a6994d2058c94b37db16f3bc7e309b240493ad3abfaa",
      "0.84.4/queue-steer-followup-stop.expected.json e50a728e753724a9758c4151ce87e50e18011de0654dd42386a89cb3273d7e72",
      "0.84.4/queue-steer-followup-stop.jsonl f1b938f9fc04882a0198d0ec7cdedf543fcd225dae4b34106280b834b693e22c",
      "0.84.4/split-utf8-lf-crlf-unicode.expected.json 8902f4883305061edfd1daaba81aec3aadaca148ab83edc34fc791bf7f69bc2f",
      "0.84.4/split-utf8-lf-crlf-unicode.jsonl fe779ef12016586038581bc42adac263e74d6e63a6b16ad1487e93b6dc079318",
      "0.84.4/text-tool-settle.expected.json 708b57116926e5bf5393ba6fbfb86cf2a61a5f9c8d94fc4eae973590b3843136",
      "0.84.4/text-tool-settle.jsonl dfd99ac695de3e2ccb1ce7d6139a2c0e030a3eaba85f81eea5c2f93dd5db8e88",
      "0.84.4/unknown-event-tool-content.expected.json dd0e8aab6cf0a8010b913e6b836203ca09caef7643ff04a62be3b295a8360749",
      "0.84.4/unknown-event-tool-content.jsonl 775d926df585901fa28037e0c79ed9790e2a715b880e04ea987279ae3828f60f",
      "0.85.1/agent-end-retry-settle.expected.json 9bddaf95cb66f4421c9f29dc14ba2d5cd14f4dc0c2d28c908282e5200eedb69b",
      "0.85.1/agent-end-retry-settle.jsonl 35fcab236b987c2d7fa5498d09f0bc40b952c1293955adf5f256e2b1a5334594",
      "0.85.1/compaction-retry-error.expected.json 408bc3a247b3da66e5d6a99ad50fda28773de82a57b774c27aabf89570e4d384",
      "0.85.1/compaction-retry-error.jsonl 542c6fa9d6c63dfdd16d4b7a0560476359047d2ae33c9b05312846ede4bf39d1",
      "0.85.1/empty-no-file-resume.expected.json eb7956bc038d9d5cba386e25533f2a64e77b904e4bc4681e452316da345448d6",
      "0.85.1/empty-no-file-resume.jsonl 14295ca6fa8795565c5baa8317be3a027759f932d34c0613b2f725028174fa27",
      "0.85.1/error-abort-length.expected.json f7f8fab3a17fd92b2837219319bc18b62ddfb8f6a4f904ba792a4e28c6fc6c58",
      "0.85.1/error-abort-length.jsonl fcc5134f75fd929ea529d3bb6f3dc6d8776deb2c5ce9053e76d21f4ab9c377d8",
      "0.85.1/extension-dialog-cancel-timeout.expected.json 63a95c778fc5d30644e05ae5d62c743be74a062dddb48aefa488db95af01bb18",
      "0.85.1/extension-dialog-cancel-timeout.jsonl 7f1e1b22b9286309e3030c2ab595572e9ffb1c109a99a64f9403f39a8a901c0c",
      "0.85.1/extension-entry-after-search.expected.json 843c1fd4917047494faa0586c3e84c9b70458097e0e935bd2da8e110b5db67a2",
      "0.85.1/extension-entry-after-search.jsonl f5c5607258aa92b07a8b018f9bc6111115842b14068db05f8815a431cf50db8f",
      "0.85.1/extension-widget-editor.expected.json 682779feef660f284b9f4019da63f7c04cb674268c14a11f29cd9089afbe8ccd",
      "0.85.1/extension-widget-editor.jsonl cff9bb8f710c6e6aeab5939b076dfcd5c4a4fd256e80d40c2dee91bfa3e8ba57",
      "0.85.1/fork-clone-cancel.expected.json b2c077e4208786f4ee6691e94ee272f860f696804a3083e9e11686fa77ecfaf3",
      "0.85.1/fork-clone-cancel.jsonl 3aca5218d9d7ca1d85175c74f71754250e65253e7a217035e74aa9f6b0b8a2ac",
      "0.85.1/header-cwd-import-preflight.expected.json bc6d8ceac5433d3d735a85d982fe37e9d761422ed2d4082212c59e8fc49591f9",
      "0.85.1/header-cwd-import-preflight.jsonl 8fc9974abd353ac453bf4fa25d1fbb295c3a062c97fc027b7c532c43cc1d1ad2",
      "0.85.1/interleaved-responses.expected.json ed035d7c9bfc4c610f0c46f00c7f9a1fba06474aaa53d1b8ea95bacd5f1ead34",
      "0.85.1/interleaved-responses.jsonl 0dfda3a14b7383e2f8c895b88d30fb4915b46d084265cf3ad4d8a0edf4b71e89",
      "0.85.1/malformed-oversize.expected.json a844377a35de4b0c7f3152438e942af35b5bb7f275640ab8af52acc0a8edc700",
      "0.85.1/malformed-oversize.jsonl 23e6910e3c61f4f5a43426da10674058cddd4727b6ad0ba2101ca34288f9a55c",
      "0.85.1/model-catalog-redaction.expected.json 4664c4f9264bfc900a9f411ff92ef9eb2b99b4940fac3a9224f4268c73cbe4f8",
      "0.85.1/model-catalog-redaction.jsonl 75cc8b7209fd76f2ad1b68020e5ad4093da0d386b6f215256de985320b9b9244",
      "0.85.1/no-global-settings-write.expected.json 27ed8a92f17fe7e6045885024e5ce6ca16c2c37603f2be23bf6f2a29ca5595fd",
      "0.85.1/no-global-settings-write.jsonl bdb0bf86444a4d929289ba9cf43a34972faafe28d80958ee74770249b979e3ba",
      "0.85.1/process-exit-before-response.expected.json ab3580401cea46076a8e8edf990133e8e026eda47abb5887ef031710489f9e06",
      "0.85.1/process-exit-before-response.jsonl 69ac99f6c407454a22b00d5a0adc0dfff122b1f7246353bbfffd2f8207b8e6d9",
      "0.85.1/prompt-accepted-not-done.expected.json 5819c197ede472fc0616506eb35d9d39f422efec9c1ea4b6dab416fefb6c8428",
      "0.85.1/prompt-accepted-not-done.jsonl ee0db51110ec86b6a4f3a6994d2058c94b37db16f3bc7e309b240493ad3abfaa",
      "0.85.1/queue-steer-followup-stop.expected.json 5975341874047850589a242cbe002dcd8f9c2363e30f9cbd1d5c975b1571107d",
      "0.85.1/queue-steer-followup-stop.jsonl f1b938f9fc04882a0198d0ec7cdedf543fcd225dae4b34106280b834b693e22c",
      "0.85.1/split-utf8-lf-crlf-unicode.expected.json a499808cd097a86d6da8cb72ac06768fd3d377fe7cfee62e8aae9ebe5e3d0cc3",
      "0.85.1/split-utf8-lf-crlf-unicode.jsonl fe779ef12016586038581bc42adac263e74d6e63a6b16ad1487e93b6dc079318",
      "0.85.1/text-tool-settle.expected.json 080de419e7d9ccdb3b38564009317b9f9d4a77f5a950ac2385e90bf4ea5f5f41",
      "0.85.1/text-tool-settle.jsonl dfd99ac695de3e2ccb1ce7d6139a2c0e030a3eaba85f81eea5c2f93dd5db8e88",
      "0.85.1/unknown-event-tool-content.expected.json be77976ce4df14631022380c9cad648344da5ee03a9b155a994438e21ace3d2a",
      "0.85.1/unknown-event-tool-content.jsonl 775d926df585901fa28037e0c79ed9790e2a715b880e04ea987279ae3828f60f",
    ]
  `);
});
