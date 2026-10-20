import { expect, it } from "vitest";
import { request } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { startHost } from "../../apps/host/src/host.js";
import { control } from "../../apps/host/src/cli.js";
import { updateFixture } from "../support/update-fixture.js";

type Origin = { origin: string };
/** Raw request so the path reaches the host without client normalization. */
const raw = (host: Origin, path: string, cookie?: string) =>
  new Promise<{ status: number; headers: Record<string, any>; body: string }>(
    (done, fail) => {
      const url = new URL(host.origin);
      const req = request(
        {
          host: url.hostname,
          port: url.port,
          path,
          headers: { Host: url.host, ...(cookie ? { Cookie: cookie } : {}) },
        },
        (res) => {
          let body = "";
          res.on("data", (chunk) => (body += chunk));
          res.on("end", () =>
            done({ status: res.statusCode!, headers: res.headers, body }),
          );
        },
      );
      req.on("error", fail);
      req.end();
    },
  );
const session = async (root: string, host: Origin) => {
  const { nonce } = await control(root, { type: "bootstrap" });
  const response = await fetch(host.origin + "/v1/bootstrap", {
    method: "POST",
    headers: { Origin: host.origin },
    body: JSON.stringify({ nonce }),
  });
  return response.headers.get("set-cookie")!.split(";")[0];
};
const notFound = (r: { status: number; body: string }) => {
  expect(r.status).toBe(404);
  expect(JSON.parse(r.body)).toEqual({
    v: 1,
    id: "",
    status: "rejected",
    error: {
      code: "NOT_FOUND",
      message: "Static asset not found.",
      retryable: false,
    },
  });
};

it("missing bundled and retained UI assets are bounded 404 responses", async () => {
  const root = await mkdtemp(join(tmpdir(), "suri-static-"));
  const assets = join(root, "assets");
  await mkdir(assets);
  await writeFile(join(assets, "index.html"), "<!doctype html><p>ok</p>");
  await writeFile(join(assets, "app.js"), "// ok");
  const host = await startHost({
    root: join(root, "data"),
    assets,
    helper: resolve("dist/native/suri-helper"),
  });
  try {
    await mkdir(join(root, "data", "ui-builds", "validbuild"), {
      recursive: true,
    });
    await writeFile(
      join(root, "data", "ui-builds", "validbuild", "index.html"),
      "<p>build</p>",
    );
    // Unchanged: valid HTML/JS, cache and CSP policy.
    const html = await raw(host, "/");
    expect(html.status).toBe(200);
    expect(html.headers["cache-control"]).toBe("no-store");
    expect(html.headers["content-security-policy"]).toContain(
      "default-src 'self'",
    );
    const js = await raw(host, "/app.js");
    expect(js.status).toBe(200);
    expect(js.headers["cache-control"]).toBe(
      "public, max-age=31536000, immutable",
    );
    // Bundled, valid retained build missing file, and missing build.
    for (const path of [
      "/missing.js",
      "/ui/bundled/missing.js",
      "/ui/validbuild/missing.js",
      "/ui/nobuild/index.html",
      "/%2e%2e/etc/passwd",
    ])
      notFound(await raw(host, path));
    expect((await raw(host, "/ui/validbuild/index.html")).status).toBe(200);
    // Traversal and malformed paths stay bounded 400, never 404.
    const denied = await raw(host, "/ui/bundled/..%2f..%2fetc/passwd");
    expect(denied.status).toBe(400);
    expect(JSON.parse(denied.body).error.code).toBe("PATH_DENIED");
    expect((await raw(host, "/%E0%A4%A")).status).toBe(400);
    expect((await raw(host, "/ui/bad%20id/x.js")).status).toBe(400);
    // Dynamic endpoint policy unchanged: unauthenticated 401, authed NOT_FOUND 400.
    expect((await raw(host, "/v1/assets/missing")).status).toBe(401);
    const cookie = await session(join(root, "data"), host);
    const asset = await raw(host, "/v1/assets/missing", cookie);
    expect(asset.status).toBe(400);
    expect(JSON.parse(asset.body).error.code).toBe("NOT_FOUND");
    expect(JSON.parse(asset.body).error.message).not.toBe(
      "Static asset not found.",
    );
  } finally {
    await host.close();
    await rm(root, { recursive: true, force: true });
  }

  const fixture = await updateFixture();
  try {
    const data = join(fixture.root, "data");
    const missingBuild = "a".repeat(64);
    expect(
      (await raw(fixture.host, `/ui/${missingBuild}/entry.js`)).status,
    ).toBe(401);
    const cookie = await session(data, fixture.host);
    notFound(await raw(fixture.host, `/ui/${missingBuild}/entry.js`, cookie));
    // Retained build present and listed: served; malformed ids stay 400.
    const served = await raw(
      fixture.host,
      `/ui/${fixture.baseline.id}/entry.js`,
      cookie,
    );
    expect(served.status).toBe(200);
    expect(
      (await raw(fixture.host, "/ui/not-a-build/entry.js", cookie)).status,
    ).toBe(400);
    // Valid build, name absent from its manifest: bounded 404, not integrity.
    const id = fixture.baseline.id;
    notFound(await raw(fixture.host, `/ui/${id}/unlisted.js`, cookie));
    // Listed-but-modified and listed-but-deleted keep their integrity error.
    const dir = join(data, "ui-builds", id);
    const integrity = async () => {
      const bad = await raw(fixture.host, `/ui/${id}/entry.js`, cookie);
      expect(bad.status).toBe(400);
      expect(JSON.parse(bad.body).error.code).not.toBe("NOT_FOUND");
    };
    await writeFile(join(dir, "entry.js"), "// tampered");
    await integrity();
    await rm(join(dir, "entry.js"));
    await integrity();
    // Disallowed names are PATH_DENIED before any artifact absence mapping.
    const malformed = [
      "..%2f..%2fetc/passwd",
      "%2e%2e%2fentry.js",
      "entry.js%00",
      "bad%5cname.js",
      "%2fentry.js",
      "C%3a/entry.js",
    ];
    const denied = async (build: string) => {
      for (const name of malformed) {
        const r = await raw(fixture.host, `/ui/${build}/${name}`, cookie);
        expect([name, r.status]).toEqual([name, 400]);
        expect([name, JSON.parse(r.body).error.code]).toEqual([
          name,
          "PATH_DENIED",
        ]);
      }
    };
    await denied(id);
    await denied(missingBuild);
    const manifestPath = join(dir, "manifest.json");
    const manifest = await readFile(manifestPath);
    try {
      await rm(manifestPath);
      await denied(id);
    } finally {
      await writeFile(manifestPath, manifest);
    }
  } finally {
    await fixture.close();
  }
});
