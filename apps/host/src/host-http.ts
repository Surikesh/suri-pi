import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { basename, join, extname, resolve } from "node:path";
import {
  CommandSchema,
  SuriError,
  failure,
  type Data,
} from "../../../packages/protocol/src/index.js";
import type { HttpCaps, UpgradeListener } from "./host-http-types.js";
import { updateLoaderHtml, updateLoaderScript } from "./update-loader.js";
import { safePath } from "./resource-path.js";
import { body, json, token } from "./host-contract.js";

/** Marks a missing static asset; the only error mapped to HTTP 404. */
class StaticMissing extends SuriError {
  constructor() {
    super("NOT_FOUND", "Static asset not found.");
  }
}
const absent = (error: unknown) =>
  ["ENOENT", "ENOTDIR"].includes((error as { code?: string })?.code ?? "")
    ? new StaticMissing()
    : error;

/** Builds the loopback HTTP server; nothing listens until `listen` is called. */
export function createHttp(caps: HttpCaps) {
  const http = createServer((req, res) => {
    let tracksIngress =
      req.method === "POST" && (req.url ?? "").startsWith("/v1/");
    if (tracksIngress) caps.beginIngress();
    void (async () => {
      const modernUpdates = caps.modernUpdates();
      const lifecycle = caps.lifecycle();
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Referrer-Policy", "no-referrer");
      res.setHeader(
        "Content-Security-Policy",
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob:; connect-src 'self'; font-src 'self'; frame-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
      );
      if (req.headers.host !== caps.origin().slice(7))
        throw new SuriError("UNAUTHORIZED", "Invalid host.");
      if (req.headers.origin && req.headers.origin !== caps.origin())
        throw new SuriError("UNAUTHORIZED", "Cross-origin request rejected.");
      const url = new URL(req.url ?? "/", caps.origin());
      if (url.pathname === "/v1/bootstrap" && req.method === "POST") {
        if (caps.closing())
          throw new SuriError(
            "HOST_STOPPING",
            "The host is stopping and cannot create a new client session.",
            true,
          );
        if (req.headers.origin !== caps.origin())
          throw new SuriError("UNAUTHORIZED", "Origin required.");
        const b = JSON.parse((await body(req, 4096)).toString());
        const expires = caps.takeNonce(b.nonce);
        if (!expires || expires.expires < Date.now())
          throw new SuriError(
            "UNAUTHORIZED",
            "Bootstrap expired or already used.",
          );
        if (modernUpdates && caps.launchIdentity) {
          try {
            await caps.retainedHosts.accept({
              profileId: modernUpdates.state.snapshot().profileId,
              activeId: caps.launchIdentity.buildId,
              fallbackUiId:
                modernUpdates.state.snapshot().packagedFallbackUiId!,
              origin: caps.origin(),
            });
          } catch {
            throw new SuriError(
              "HOST_SELECTION_WRITE_FAILED",
              "Retained launch identity could not be saved; keep this host running.",
            );
          }
        }
        const secret = token(),
          csrf = token(),
          id = expires.clientId ?? randomUUID();
        caps.addClient(secret, {
          id,
          csrf,
          expires: Date.now() + 8 * 3600000,
          restartOperationId: expires.restartOperationId,
        });
        res.setHeader(
          "Set-Cookie",
          `${caps.cookieName()}=${secret}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800`,
        );
        json(res, 200, { v: 1, csrf, clientId: id });
        return;
      }
      if (
        lifecycle &&
        req.method === "POST" &&
        url.pathname === "/v1/restart-handoff"
      ) {
        if (caps.closing() || req.headers.origin !== caps.origin())
          throw new SuriError(
            "UNAUTHORIZED",
            "Same-origin restart handoff required.",
          );
        await body(req, 4096);
        const restartCookie = req.headers.cookie
          ?.split(/; */)
          .find((value) => value.startsWith(`${caps.cookieName()}_restart=`))
          ?.slice(caps.cookieName().length + 9);
        try {
          const group = await lifecycle.handoffs.consume(restartCookie, {
            profileId: modernUpdates!.state.snapshot().profileId,
            targetBuildId: caps.launchIdentity?.buildId ?? null,
            instanceId: caps.instanceId,
            origin: caps.origin(),
          });
          const nonce = token();
          caps.addNonce(nonce, {
            clientId: group.authClientId,
            expires: Date.now() + 60000,
            restartOperationId: group.operationId,
          });
          res.setHeader(
            "Set-Cookie",
            `${caps.cookieName()}_restart=; HttpOnly; SameSite=Strict; Path=/v1/restart-handoff; Max-Age=0`,
          );
          res.setHeader("Cache-Control", "no-store");
          json(res, 200, { nonce });
          return;
        } catch (error) {
          const code =
            error instanceof Error && "code" in error
              ? String(error.code)
              : "HANDOFF_UNAVAILABLE";
          throw new SuriError(
            code,
            "Reconnect securely using the local launcher.",
          );
        }
      }
      if (url.pathname.startsWith("/v1/")) {
        const client = caps.peek(req);
        if (
          modernUpdates &&
          req.method === "GET" &&
          url.pathname === "/v1/ui-selection"
        ) {
          caps.auth(req, res);
          res.setHeader("Cache-Control", "no-store");
          json(
            res,
            200,
            await modernUpdates.selection(
              url.searchParams.get("client") ?? "",
              client.id,
            ),
          );
          return;
        }
        if (req.method === "GET" && url.pathname.startsWith("/v1/assets/")) {
          caps.auth(req, res);
          const { asset, bytes } = await caps.assets.read(
            url.pathname.slice(11),
          );
          res.setHeader(
            "Content-Type",
            asset.mime.startsWith("image/")
              ? asset.mime
              : "text/plain; charset=utf-8",
          );
          res.setHeader("Cache-Control", "private, max-age=3600");
          if (url.searchParams.get("download") === "1")
            res.setHeader(
              "Content-Disposition",
              `attachment; filename="${String(asset.name ?? "suri-output.txt").replace(/["\\\r\n]/g, "_")}"`,
            );
          res.end(bytes);
          return;
        }
        if (req.method === "GET" && url.pathname === "/v1/client") {
          caps.auth(req, res);
          json(res, 200, { csrf: client.csrf, clientId: client.id });
          return;
        }
        if (
          req.method !== "POST" ||
          req.headers.origin !== caps.origin() ||
          req.headers["x-suri-csrf"] !== client.csrf
        )
          throw new SuriError(
            "UNAUTHORIZED",
            "Authenticated same-origin command required.",
          );
        caps.auth(req, res);
        if (caps.closing() && url.pathname !== "/v1/commands")
          throw new SuriError(
            "HOST_STOPPING",
            "The host is stopping and cannot accept new writes.",
            true,
          );
        if (lifecycle && url.pathname === "/v1/restart-handoff/mint") {
          const input = JSON.parse((await body(req, 4096)).toString());
          try {
            const binding = lifecycle.restart.binding(
              input.operationId,
              input.barrierId,
            );
            const secret = await lifecycle.handoffs.mint(binding, client.id);
            res.setHeader(
              "Set-Cookie",
              `${caps.cookieName()}_restart=${secret}; HttpOnly; SameSite=Strict; Path=/v1/restart-handoff; Max-Age=120`,
            );
            res.setHeader("Cache-Control", "no-store");
            json(res, 200, { expiresIn: 120 });
            return;
          } catch {
            throw new SuriError(
              "RESTART_BARRIER_CLOSED",
              "The approved restart barrier is no longer open.",
            );
          }
        }
        if (url.pathname === "/v1/import-files") {
          const bytes = await body(req, 32 * 1048576);
          const name = basename(
            decodeURIComponent(
              String(req.headers["x-suri-name"] ?? "history.jsonl"),
            ),
          ).slice(0, 200);
          const id = randomUUID();
          const directory = join(caps.root, "import-staging", id);
          await mkdir(directory, { recursive: true, mode: 0o700 });
          const path = join(directory, name || "history.jsonl");
          await writeFile(path, bytes, { mode: 0o600 });
          caps.mintGrant(id, {
            path,
            kind: "file",
            expires: Date.now() + 30 * 60 * 1000,
          });
          json(res, 200, { grantId: id });
          return;
        }
        if (url.pathname === "/v1/attachments") {
          const bytes = await body(req, 10 * 1048576);
          const asset = await caps.assets.upload(
            bytes,
            decodeURIComponent(
              String(req.headers["x-suri-name"] ?? "attachment"),
            ),
            String(req.headers["content-type"] ?? ""),
            String(req.headers["x-suri-kind"] ?? "attachment"),
            String(req.headers["x-suri-session"] ?? ""),
          );
          json(res, 200, asset);
          return;
        }
        if (url.pathname === "/v1/commands") {
          const c = CommandSchema.safeParse(
            JSON.parse((await body(req, 2 * 1048576)).toString()),
          );
          if (!c.success)
            throw new SuriError("VALIDATION", "Invalid command envelope.");
          if (caps.isPureCommand(c.data.type) && tracksIngress) {
            tracksIngress = false;
            caps.endIngress();
          }
          json(res, 200, await caps.execute(c.data, client.id));
          return;
        }
        throw new SuriError("NOT_FOUND", "Endpoint not found.");
      }
      if (req.method !== "GET")
        throw new SuriError("VALIDATION", "Method not allowed.");
      let path = decodeURIComponent(url.pathname);
      if (modernUpdates) {
        if (path === "/" || /^\/ui\/[^/]+\/index\.html$/.test(path)) {
          res.statusCode = 302;
          res.setHeader("Location", "/app" + url.search);
          res.setHeader("Cache-Control", "no-store");
          res.end();
          return;
        }
        if (["/app", "/recover", "/update-loader.js"].includes(path)) {
          res.setHeader("Cache-Control", "no-store");
          res.setHeader(
            "Content-Type",
            path.endsWith(".js") ? "text/javascript" : "text/html",
          );
          res.end(path.endsWith(".js") ? updateLoaderScript : updateLoaderHtml);
          return;
        }
        if (path.startsWith("/ui/")) {
          caps.auth(req, res);
          const segments = path.split("/");
          let bytes;
          try {
            bytes = await modernUpdates.readAsset(
              segments[2],
              segments.slice(3).join("/"),
            );
          } catch (error) {
            throw absent(error);
          }
          res.setHeader(
            "Cache-Control",
            "private, max-age=31536000, immutable",
          );
          res.setHeader(
            "Content-Type",
            (
              {
                ".js": "text/javascript",
                ".css": "text/css",
                ".svg": "image/svg+xml",
                ".png": "image/png",
                ".json": "application/json",
              } as Data
            )[extname(path)] ?? "application/octet-stream",
          );
          res.end(bytes);
          return;
        }
      }
      let assetRoot = caps.assetsDir;
      if (path.startsWith("/ui/")) {
        const segments = path.split("/");
        assetRoot = caps.ui.path(segments[2]);
        path = "/" + segments.slice(3).join("/");
      }
      if (path === "/") path = "/index.html";
      safePath(path.slice(1));
      const file = resolve(assetRoot, path.slice(1));
      if (!file.startsWith(resolve(assetRoot) + "/"))
        throw new SuriError("PATH_DENIED", "Asset path denied.");
      let bytes;
      try {
        bytes = await readFile(file);
      } catch (error) {
        throw absent(error);
      }
      res.setHeader(
        "Content-Type",
        (
          {
            ".html": "text/html",
            ".js": "text/javascript",
            ".css": "text/css",
            ".svg": "image/svg+xml",
            ".png": "image/png",
            ".webmanifest": "application/manifest+json",
          } as Data
        )[extname(file)] ?? "application/octet-stream",
      );
      res.setHeader(
        "Cache-Control",
        path.endsWith(".html")
          ? "no-store"
          : "public, max-age=31536000, immutable",
      );
      res.end(bytes);
    })()
      .catch((e) => {
        if (!res.headersSent)
          json(
            res,
            e instanceof SuriError && e.code === "UNAUTHORIZED"
              ? 401
              : e instanceof StaticMissing
                ? 404
                : 400,
            failure("", e),
          );
        else res.end();
      })
      .finally(() => {
        if (tracksIngress) caps.endIngress();
      });
  });
  return {
    onUpgrade(listener: UpgradeListener) {
      http.on("upgrade", listener);
    },
    listen() {
      return new Promise<void>((resolve, reject) => {
        http.once("error", reject);
        http.listen(caps.port ?? 0, "127.0.0.1", resolve);
      });
    },
    address() {
      const address = http.address();
      if (!address || typeof address === "string") throw Error();
      return address;
    },
    close(callback: () => void) {
      http.close(callback);
      http.closeAllConnections();
    },
  };
}
