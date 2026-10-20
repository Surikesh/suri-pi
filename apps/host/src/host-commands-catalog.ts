import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import {
  SuriError,
  requiredString,
  type Command,
  type Data,
} from "../../../packages/protocol/src/index.js";
import type { DirectoryPicker } from "./directory-picker.js";
import type { Grants } from "./host-grants.js";
import type { HostRuntime } from "./host-runtime.js";
import type { Stream } from "./host-stream.js";
import type { ModernUpdates } from "./modern-updates.js";
import { sessionTitle } from "./session-name.js";
import type { Storage } from "./storage.js";

/** Narrow capabilities of the catalog commands (reads are lazy getters). */
type CatalogCaps = {
  store: Storage;
  options: { validation?: boolean; simulated?: boolean };
  launchIdentity: { buildId: string; adapterId: string } | undefined;
  modernUpdates: () => ModernUpdates | undefined;
  directoryPicker: DirectoryPicker;
  validationGrant: Grants["validationGrant"];
  hostRuntime: Pick<HostRuntime, "hasClient" | "isBooting">;
  publish: Stream["publish"];
  idle: (sessionId: string) => void;
};

/**
 * Synchronous catalog command bodies. Awaited cases keep their await frame in
 * the dispatcher and call these only for the synchronous parts.
 */
export function createCatalogCommands(caps: CatalogCaps) {
  const { store, options, launchIdentity, directoryPicker, publish } = caps;
  const { validationGrant, hostRuntime, idle } = caps;
  const catalog = () => ({
    runtimeMode: options.simulated ? "simulated" : "live",
    projects: store.list("project").filter((p) => !p.forgotten),
    workspaces: store
      .list("workspace")
      .filter(
        (w) => !w.forgotten && !store.get("project", w.projectId).forgotten,
      ),
    sections: store.list("section").filter((s) => !s.forgotten),
    sessions: store.list("session").map((s) => {
      const snapshot = store.snapshot(`session:${s.id}`);
      const firstPrompt = snapshot.messages
        .find((message) => message.role === "user")
        ?.blocks.filter(
          (block) => block.kind === "text" && typeof block.text === "string",
        )
        .map((block) => block.text)
        .join(" ");
      return {
        ...s,
        name:
          s.name === "New session" && firstPrompt
            ? sessionTitle(firstPrompt)
            : s.name,
        hasConversation:
          Boolean(s.hasConversation) ||
          snapshot.messages.some(
            (message) =>
              message.role === "user" || message.role === "assistant",
          ),
        phase: snapshot.phase,
        seq: snapshot.seq,
        unread: snapshot.seq > (s.lastReadSeq ?? 0),
      };
    }),
    runtimes: store.list("runtime").map(({ executable: _e, ...r }) => r),
  });
  return {
    catalog,
    hostGet(): Data {
      const modernUpdates = caps.modernUpdates();
      return {
        protocol: 1,
        build: "0.1.0",
        hostBuildId: launchIdentity?.buildId ?? null,
        adapterBuildId: launchIdentity?.adapterId ?? null,
        hostEpoch: store.epoch,
        capabilities: [
          "sessions",
          "files",
          "git",
          "terminal",
          ...(modernUpdates ? ["updates-v1"] : []),
        ],
        limits: { sessions: 4, terminals: 4 },
        validation: !!options.validation,
        runtimeMode: options.simulated ? "simulated" : "live",
      };
    },
    /** Sync guard of updates.get; the awaiting try/catch stays in dispatch. */
    updatesGetGuard(p: Data) {
      if (Object.keys(p).length)
        throw new SuriError(
          "VALIDATION",
          "Updates status takes no parameters.",
        );
    },
    /** Maps an update-status failure; dispatch throws the returned error. */
    updatesGetFailure(error: unknown) {
      const code =
        error instanceof Error && "code" in error
          ? error.code
          : "INTERNAL_UNCLASSIFIED";
      return new SuriError(
        code === "UPDATE_STATE_CORRUPT"
          ? "UPDATE_STATE_CORRUPT"
          : code === "STORAGE_UNAVAILABLE"
            ? "STORAGE_UNAVAILABLE"
            : "INTERNAL_UNCLASSIFIED",
        "Update status is unavailable; update mutations remain disabled.",
      );
    },
    catalogGet(): Data {
      return catalog();
    },
    // Single-expression awaits: the promise is returned unwrapped (not async).
    directoryList(clientId: string, p: Data) {
      return directoryPicker.list(
        clientId,
        p.path === undefined ? undefined : requiredString(p, "path", 4096),
      );
    },
    directoryCreate(clientId: string, p: Data) {
      return directoryPicker.create(clientId, requiredString(p, "path", 4096));
    },
    /** project.add after the awaited root resolution and directory check. */
    projectAdd(root: string, p: Data): Data {
      let result: Data;
      const exists = store.list("project").find((x) => x.root === root);
      if (exists) {
        result = exists.forgotten
          ? store.patch("project", exists.id, exists.revision, {
              forgotten: false,
            })
          : exists;
        publish("catalog", "catalog.project", result);
        return result;
      }
      const project = {
        id: randomUUID(),
        root,
        label: p.label ?? root.split("/").at(-1),
        revision: 1,
      };
      const workspace = {
        id: randomUUID(),
        projectId: project.id,
        root,
        label: project.label,
        revision: 1,
      };
      store.db.transaction(() => {
        store.put("project", project);
        store.put("workspace", workspace);
      })();
      publish("catalog", "catalog.project", project);
      result = project;
      return result;
    },
    projectUpdate(c: Command, p: Data): Data {
      let result: Data = {};
      const patch: Data = {};
      if ("label" in p) patch.label = requiredString(p, "label", 120);
      if ("sectionId" in p) {
        if (p.sectionId && p.sectionId !== "pinned") {
          const section = store.get("section", p.sectionId);
          if (section.forgotten)
            throw new SuriError("NOT_FOUND", "Section was removed.");
        }
        patch.sectionId = p.sectionId || null;
      }
      if (Number.isFinite(p.order)) patch.order = p.order;
      result = store.patch(
        "project",
        requiredString(p, "projectId"),
        c.expectedRevision,
        patch,
      );
      publish("catalog", "catalog.project", result);
      return result;
    },
    sectionCreate(p: Data): Data {
      let result: Data = {};
      result = store.put("section", {
        id: randomUUID(),
        label: requiredString(p, "label", 120),
        order: store.list("section").length,
        collapsed: false,
        revision: 1,
      });
      publish("catalog", "catalog.section", result);
      return result;
    },
    sectionUpdate(c: Command, p: Data): Data {
      let result: Data = {};
      const patch: Data = {};
      if ("label" in p) patch.label = requiredString(p, "label", 120);
      if ("collapsed" in p) patch.collapsed = !!p.collapsed;
      if (Number.isFinite(p.order)) patch.order = p.order;
      result = store.patch(
        "section",
        requiredString(p, "sectionId"),
        c.expectedRevision,
        patch,
      );
      publish("catalog", "catalog.section", result);
      return result;
    },
    sectionDelete(c: Command, p: Data): Data {
      let result: Data = {};
      store.db.transaction(() => {
        result = store.patch(
          "section",
          requiredString(p, "sectionId"),
          c.expectedRevision,
          { forgotten: true },
        );
        for (const project of store
          .list("project")
          .filter((item) => item.sectionId === p.sectionId))
          store.patch("project", project.id, project.revision, {
            sectionId: null,
          });
      })();
      publish("catalog", "catalog.section", result);
      return result;
    },
    /** workspace.add after the awaited root resolution and directory check. */
    workspaceAdd(root: string, p: Data): Data {
      let result: Data = {};
      const existing = store
        .list("workspace")
        .find((w) => w.root === root && w.projectId === p.projectId);
      result = existing
        ? store.patch("workspace", existing.id, existing.revision, {
            forgotten: false,
          })
        : store.put("workspace", {
            id: randomUUID(),
            projectId: p.projectId,
            root,
            label: p.label || basename(root),
            revision: 1,
          });
      publish("catalog", "catalog.workspace", result);
      return result;
    },
    workspaceForget(c: Command, p: Data): Data {
      let result: Data = {};
      const w = store.get("workspace", requiredString(p, "workspaceId"));
      for (const session of store
        .list("session")
        .filter((s) => s.workspaceId === w.id))
        idle(session.id);
      result = store.patch("workspace", w.id, c.expectedRevision, {
        forgotten: true,
      });
      publish("catalog", "catalog.workspace", result);
      return result;
    },
    projectForget(c: Command, p: Data): Data {
      let result: Data = {};
      const project = store.get("project", p.projectId);
      for (const s of store.list("session"))
        if (store.get("workspace", s.workspaceId).projectId === project.id)
          idle(s.id);
      result = store.patch("project", project.id, c.expectedRevision, {
        forgotten: true,
      });
      publish("catalog", "catalog.project", result);
      return result;
    },
    runtimeList(): Data {
      return { runtimes: catalog().runtimes };
    },
    selectionId(p: Data) {
      return requiredString(p, "directorySelectionId");
    },
    grantId(p: Data) {
      return requiredString(p, "directoryGrantId");
    },
    requireDirectory(info: { isDirectory(): boolean }) {
      if (!info.isDirectory())
        throw new SuriError("VALIDATION", "Select a directory.");
    },
    /** Simulated runtime probe result from the already-read executable bytes. */
    simulatedRuntime(executable: string, version: string, identity: string) {
      return {
        executable,
        version,
        identity,
        status: "candidate",
        adapterVersion: 1,
      };
    },
    /** runtime.register after the awaited candidate check. */
    runtimeRegister(check: Data): Data {
      let result: Data = {};
      result = store.put("runtime", {
        id: randomUUID(),
        ...check,
        revision: 1,
      });
      return result;
    },
    /** Sync prelude of runtime.validate; dispatch keeps the asyncJobs receipt. */
    runtimeValidatePrelude(p: Data) {
      if (options.simulated)
        throw new SuriError(
          "RUNTIME_VALIDATION_UNAUTHORIZED",
          "Simulated hosts cannot promote runtimes.",
        );
      const runtimeId = requiredString(p, "runtimeId");
      const profile = validationGrant(requiredString(p, "validationGrantId"));
      if (
        store
          .list("session")
          .some(
            (session) =>
              session.runtimeId === runtimeId &&
              (hostRuntime.hasClient(String(session.id)) ||
                hostRuntime.isBooting(String(session.id))),
          )
      )
        throw new SuriError(
          "BUSY",
          "Close active sessions for this runtime before validation.",
          true,
        );
      store.get("runtime", runtimeId);
      return { runtimeId, profile };
    },
  };
}
