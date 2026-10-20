import { createHash } from "node:crypto";
import { basename } from "node:path";
import {
  SuriError,
  requiredString,
  type Command,
  type Data,
} from "../../../packages/protocol/src/index.js";
import type { Assets } from "./assets.js";
import type { Resources } from "./resources.js";
import { safePath } from "./resource-path.js";
import type { Stream } from "./host-stream.js";
import type { Storage } from "./storage.js";
import type { UiBuilds } from "./ui-builds.js";

const iconPaths = [
  ".dsh/icon.svg",
  ".suri/icon.png",
  ".suri/icon.jpg",
  ".suri/icon.webp",
  "favicon.png",
];

/**
 * Workspace attachment, UI build, icon and artifact command bodies. Awaited
 * cases keep their await/loop/try skeleton in the dispatcher.
 */
export function createAssetCommands(caps: {
  store: Storage;
  assets: Pick<Assets, "upload">;
  resources: Pick<Resources, "file">;
  ui: Pick<UiBuilds, "list" | "import">;
  publish: Stream["publish"];
}) {
  const { store, assets, resources, ui, publish } = caps;
  const iconKind = (p: Data) => {
    const targetId = requiredString(p, "targetId");
    if (store.list("project").some((x) => x.id === targetId)) return "project";
    if (store.list("session").some((x) => x.id === targetId)) return "session";
    throw new SuriError("NOT_FOUND", "Icon target was not found.");
  };
  return {
    /** attachment.workspace validation before the awaited file read. */
    attachmentPrelude(p: Data, id: string) {
      const session = store.get("session", id);
      const workspaceId = requiredString(p, "workspaceId");
      if (session.workspaceId !== workspaceId)
        throw new SuriError(
          "PATH_DENIED",
          "Choose a file from the session workspace.",
        );
      const w = store.get("workspace", workspaceId);
      const path = safePath(p.path);
      return { w, path };
    },
    attachmentRead(w: Data, path: string) {
      return resources.file(w.root, path, false, 0, 1048576);
    },
    attachmentCheck(file: Data) {
      if (file.encoding !== "utf8" || file.truncated)
        throw new SuriError(
          "LIMIT_EXCEEDED",
          "Context files must be UTF-8 text smaller than 1 MiB.",
        );
    },
    attachmentUpload(file: Data, path: string, id: string) {
      return assets.upload(
        Buffer.from(file.content, "utf8"),
        path.split("/").at(-1) ?? "context.txt",
        "text/plain",
        "attachment",
        id,
      );
    },
    uiBuilds() {
      return ui.list();
    },
    uiBuildId(p: Data): string {
      return requiredString(p, "buildId");
    },
    uiImport(buildId: string) {
      return ui.import(buildId);
    },
    uiActivated(buildId: string): Data {
      return { buildId, url: `/ui/${buildId}/index.html` };
    },
    uiRollback(): Data {
      return { buildId: "bundled", url: "/" };
    },
    iconProject(p: Data) {
      return store.get("project", requiredString(p, "projectId"));
    },
    iconPaths() {
      return iconPaths;
    },
    /** One discovery candidate: decoded bytes and their cache hash. */
    iconDigest(file: Data, path: string) {
      const bytes = Buffer.from(
        file.content!,
        file.encoding === "base64" ? "base64" : "utf8",
      );
      const hash = createHash("sha256")
        .update(path.endsWith(".svg") ? "svg-png@3x\0" : "raster\0")
        .update(bytes)
        .digest("hex");
      return { bytes, hash };
    },
    iconUpload(bytes: Buffer, path: string) {
      return assets.upload(
        bytes,
        basename(path),
        path.endsWith(".svg")
          ? "image/svg+xml"
          : path.endsWith(".jpg")
            ? "image/jpeg"
            : path.endsWith(".webp")
              ? "image/webp"
              : "image/png",
        "icon",
        "",
      );
    },
    /** project.discoverIcon persistence after the awaited candidate loop. */
    iconDiscovered(project: Data, autoIconId: string | null): Data {
      const currentProject = store.get("project", project.id);
      const autoIconHash = autoIconId ? project.autoIconHash : null;
      // Discovery is an idempotent background read. A second window or an
      // explicit edit wins without a spurious catalog conflict banner.
      if (
        currentProject.revision !== project.revision ||
        ((currentProject.autoIconId ?? null) === autoIconId &&
          (currentProject.autoIconHash ?? null) === autoIconHash)
      ) {
        return currentProject;
      }
      const result = store.patch("project", project.id, project.revision, {
        autoIconId,
        autoIconHash,
      });
      publish("catalog", "catalog.project", result);
      return result;
    },
    /** artifact.get requires an owning session before any blob IO. */
    artifactOwner(id: string | undefined): string {
      if (!id) throw new SuriError("VALIDATION", "Select a session.");
      return id;
    },
    iconClear(c: Command, p: Data): Data {
      const kind = iconKind(p);
      const result = store.patch(
        kind,
        requiredString(p, "targetId"),
        c.expectedRevision,
        { iconId: null },
      );
      publish("catalog", `catalog.${kind}`, result);
      return result;
    },
    iconSet(c: Command, p: Data): Data {
      const a = store.get("asset", requiredString(p, "assetId"));
      if (a.kind !== "icon")
        throw new SuriError("VALIDATION", "Select a decoded icon image.");
      const kind = iconKind(p);
      const result = store.patch(
        kind,
        requiredString(p, "targetId"),
        c.expectedRevision,
        { iconId: a.id },
      );
      publish("catalog", `catalog.${kind}`, result);
      return result;
    },
    /** artifact.get response slice after the awaited asset read. */
    artifactSlice(p: Data, asset: Data, bytes: Buffer): Data {
      return {
        ...asset,
        data: bytes
          .subarray(
            p.offset ?? 0,
            Math.min((p.offset ?? 0) + (p.length ?? 1048576), bytes.length),
          )
          .toString("base64"),
      };
    },
  };
}
