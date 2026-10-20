import { rm } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import {
  SuriError,
  requiredString,
  type Data,
} from "../../../packages/protocol/src/index.js";
import type { PiClient } from "../../../packages/pi-adapter/src/index.js";
import type { Grants } from "./host-grants.js";
import type { HostRuntime } from "./host-runtime.js";
import type { Stream } from "./host-stream.js";
import type { Storage } from "./storage.js";

/**
 * Pi history import command bodies. Reads, copies, header checks, realpath and
 * session starts stay awaited in the dispatcher; operations here are
 * synchronous before/after blocks.
 */
export function createImportCommands(caps: {
  store: Storage;
  root: string;
  grants: Pick<Grants, "grant" | "inspectGrant" | "discard">;
  hostRuntime: Pick<HostRuntime, "client" | "dropClient">;
  publish: Stream["publish"];
}) {
  const { store, root, grants, hostRuntime, publish } = caps;
  const { grant, inspectGrant } = grants;
  return {
    /** session.import validation before the awaited read. */
    importPrelude(p: Data) {
      const source = grant(requiredString(p, "fileGrantId"), "file");
      const w = store.get("workspace", requiredString(p, "workspaceId"));
      store.get("runtime", requiredString(p, "runtimeId"));
      return { source, w };
    },
    importTarget(nextId: string) {
      const dir = join(root, "runtime", nextId);
      const piFile = join(dir, "import.jsonl");
      return { dir, piFile };
    },
    importPut(p: Data, w: Data, nextId: string, piFile: string, header: Data) {
      return store.put("session", {
        id: nextId,
        workspaceId: w.id,
        runtimeId: requiredString(p, "runtimeId"),
        name:
          typeof header.name === "string" && header.name.trim()
            ? header.name.trim().slice(0, 200)
            : "Imported session",
        revision: 1,
        archived: false,
        piFile,
        piSessionId: header.id,
      });
    },
    /** Single import owns no runtime after completion: drop it, clear the pid, publish. */
    importSettle(nextId: string, next: Data) {
      hostRuntime.dropClient(nextId);
      store.put("session", {
        ...store.get("session", nextId),
        processPid: undefined,
      });
      publish("catalog", "catalog.session", next);
      return next;
    },
    /** session.importPreview validation and existing-session set. */
    previewPrelude(p: Data) {
      const ids = Array.isArray(p.fileGrantIds) ? p.fileGrantIds : [];
      if (!ids.length || ids.length > 100)
        throw new SuriError(
          "VALIDATION",
          "Choose between 1 and 100 Pi history files.",
        );
      const w = store.get("workspace", requiredString(p, "workspaceId"));
      const existing = new Set(
        store
          .list("session")
          .map((entry) => entry.piSessionId)
          .filter(Boolean),
      );
      return { ids, w, existing };
    },
    previewGrant(grantId: unknown): string {
      return inspectGrant(String(grantId), "file");
    },
    previewCandidate(
      grantId: unknown,
      source: string,
      header: Data,
      sameWorkspace: boolean,
      existing: Set<unknown>,
    ): Data {
      return {
        grantId,
        fileName: basename(source),
        piSessionId: header.id,
        cwd: header.cwd,
        name: String(header.name ?? basename(source, extname(source))).slice(
          0,
          200,
        ),
        status: existing.has(header.id)
          ? "duplicate"
          : sameWorkspace
            ? "ready"
            : "path-mismatch",
      };
    },
    previewIncompatible(grantId: unknown, source: string): Data {
      return {
        grantId,
        fileName: basename(source),
        status: "incompatible",
        reason: "This file is not a compatible Pi history.",
      };
    },
    /** session.importBatch validation before the awaited loop. */
    batchPrelude(p: Data) {
      const ids = Array.isArray(p.fileGrantIds) ? p.fileGrantIds : [];
      if (!ids.length || ids.length > 100)
        throw new SuriError("VALIDATION", "Choose compatible histories.");
      const workspaceId = requiredString(p, "workspaceId");
      const runtimeId = requiredString(p, "runtimeId");
      const w = store.get("workspace", workspaceId);
      store.get("runtime", runtimeId);
      return { ids, workspaceId, runtimeId, w };
    },
    batchGrant(grantId: unknown): string {
      return inspectGrant(String(grantId), "file");
    },
    /** Skipped entry when the header's Pi session is already imported. */
    batchDuplicate(grantId: unknown, header: Data): Data | undefined {
      const duplicate = store
        .list("session")
        .find((entry) => entry.piSessionId === header.id);
      if (duplicate) {
        return {
          grantId,
          status: "duplicate",
          sessionId: duplicate.id,
        };
      }
      return undefined;
    },
    batchPut(
      batch: { workspaceId: string; runtimeId: string },
      nextId: string,
      source: string,
      piFile: string,
      header: Data,
    ) {
      const { workspaceId, runtimeId } = batch;
      return store.put("session", {
        id: nextId,
        workspaceId,
        runtimeId,
        name: String(header.name ?? basename(source, extname(source))).slice(
          0,
          200,
        ),
        nameSource: "imported",
        revision: 1,
        archived: false,
        piFile,
        piSessionId: header.id,
      });
    },
    /** Settles a started import session; the grant is discarded afterwards. */
    batchSettle(pi: PiClient, nextId: string, next: Data, grantId: unknown) {
      pi.close();
      hostRuntime.dropClient(nextId);
      store.put("session", {
        ...store.get("session", nextId),
        processPid: undefined,
      });
      publish("catalog", "catalog.session", next);
      return { grantId, status: "imported", sessionId: nextId };
    },
    batchDiscard(grantId: unknown) {
      grants.discard(String(grantId));
    },
    /**
     * Single-import failure: confirm the child exited (grace, SIGTERM, SIGKILL)
     * before forgetting it or removing storage. Works before any row or child
     * exists (removes only the new private dir). If retirement throws, the
     * child, row and dir stay owned and are removed once the child exits.
     */
    async importRollback(nextId: string, dir: string) {
      const client = hostRuntime.client(nextId);
      try {
        await client?.retireFailedStartup();
      } catch {
        void client?.exited
          .then(() => {
            this.batchRollback(nextId);
            return rm(dir, { recursive: true, force: true });
          })
          .catch(() => {
            // Best effort: nothing awaits this deferred cleanup; the original import error is already reported.
          });
        return;
      }
      this.batchRollback(nextId);
      await rm(dir, { recursive: true, force: true });
    },
    /** Failure cleanup before the awaited directory removal. */
    batchRollback(nextId: string) {
      hostRuntime.client(nextId)?.close();
      hostRuntime.dropClient(nextId);
      store.remove("session", nextId);
    },
  };
}
