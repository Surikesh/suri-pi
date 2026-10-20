import { randomUUID } from "node:crypto";
import { basename, resolve } from "node:path";
import {
  SuriError,
  requiredString,
  type Command,
  type Data,
} from "../../../packages/protocol/src/index.js";
import type { Resources } from "./resources.js";
import { safePath } from "./resource-path.js";
import type { Stream } from "./host-stream.js";
import type { Storage } from "./storage.js";

/**
 * File, external-file, git, workspace-discovery and terminal command bodies.
 * Awaited cases keep their await frame in the dispatcher; operations here are
 * synchronous or return the promise produced by an existing call.
 */
export function createFileCommands(caps: {
  store: Storage;
  resources: Pick<
    Resources,
    "file" | "systemFile" | "writeFile" | "git" | "createTerminal" | "terminal"
  >;
  publish: Stream["publish"];
}) {
  const { store, resources, publish } = caps;
  const workspaceCandidates = new Map<
    string,
    { root: string; projectId: string; label: string }
  >();
  return {
    fileRead(c: Command, p: Data) {
      const w = store.get("workspace", requiredString(p, "workspaceId"));
      return resources.file(
        w.root,
        safePath(p.path ?? "."),
        c.type === "file.list",
        c.type === "file.list" ? Number(p.cursor ?? 0) : p.offset,
        p.length,
      );
    },
    /** externalFile.read validation before the awaited realpath/stat. */
    externalReadPath(p: Data): string {
      const path = requiredString(p, "path", 4096);
      if (!p.confirmed || !path.startsWith("/"))
        throw new SuriError(
          "PATH_DENIED",
          "Confirm access to this external file.",
        );
      return path;
    },
    /** Maps absent/denied realpath/stat failures to bounded domain errors. */
    externalFail(error: unknown): never {
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      if (code === "ENOENT" || code === "ENOTDIR")
        throw new SuriError("NOT_FOUND", "External file is unavailable.");
      if (code === "EACCES" || code === "EPERM")
        throw new SuriError("PATH_DENIED", "External file access was denied.");
      throw error;
    },
    /** externalFile.read check after the awaited realpath/stat. */
    externalReadCheck(
      canonical: string,
      path: string,
      info: { isFile(): boolean },
    ) {
      if (canonical !== path || !info.isFile())
        throw new SuriError(
          "PATH_DENIED",
          "The external file changed or is a symbolic link.",
        );
    },
    externalRead(canonical: string, p: Data) {
      return resources.file(
        resolve(canonical, ".."),
        basename(canonical),
        false,
        p.offset,
        p.length,
      );
    },
    /** externalFile.open/openWith/reveal validation before realpath/stat. */
    externalOpenPath(p: Data): string {
      const path = requiredString(p, "path", 4096);
      if (!p.confirmed || !path.startsWith("/"))
        throw new SuriError(
          "PATH_DENIED",
          "Confirm access to this external file.",
        );
      return path;
    },
    externalOpenCheck(
      canonical: string,
      path: string,
      info: { isFile(): boolean },
    ) {
      if (canonical !== path || !info.isFile())
        throw new SuriError(
          "PATH_DENIED",
          "The external file changed or is a symbolic link.",
        );
    },
    externalOpen(c: Command, canonical: string) {
      return resources.systemFile(
        resolve(canonical, ".."),
        basename(canonical),
        c.type.slice(13) as "open" | "openWith" | "reveal",
      );
    },
    fileWrite(p: Data) {
      const w = store.get("workspace", requiredString(p, "workspaceId"));
      if (typeof p.content !== "string" || p.content.length > 1048576)
        throw new SuriError("VALIDATION", "Invalid file content.");
      return resources.writeFile(
        w.root,
        safePath(p.path),
        p.content,
        requiredString(p, "expectedRevision", 128),
      );
    },
    fileOpen(c: Command, p: Data) {
      const w = store.get("workspace", requiredString(p, "workspaceId"));
      return resources.systemFile(
        w.root,
        safePath(p.path),
        c.type.slice(5) as "open" | "openWith" | "reveal",
      );
    },
    gitWorkspace(p: Data) {
      const w = p.workspaceId
        ? store.get("workspace", p.workspaceId)
        : store.list("workspace").find((w) => w.projectId === p.projectId);
      if (!w) throw new SuriError("NOT_FOUND", "Workspace not found.");
      return w;
    },
    gitRead(w: Data, c: Command, p: Data) {
      return resources.git(w.root, c.type, p);
    },
    /** workspace.list post-processing of the awaited git result. */
    workspaceCandidates(w: Data, result: Data): Data {
      const candidates: Data[] = [];
      for (const record of String(result.text).split("\0\0")) {
        const fields = record.split("\0");
        const root = fields.find((x) => x.startsWith("worktree "))?.slice(9);
        if (!root) continue;
        const label =
          fields.find((x) => x.startsWith("branch "))?.slice(7) ??
          "Detached worktree";
        const candidateId = randomUUID();
        workspaceCandidates.set(candidateId, {
          root,
          projectId: w.projectId,
          label,
        });
        candidates.push({ candidateId, root, label });
      }
      return { candidates };
    },
    /** workspace.select validation before the awaited realpath. */
    workspaceSelectCandidate(p: Data) {
      const candidate = workspaceCandidates.get(
        requiredString(p, "candidateId"),
      );
      if (!candidate || candidate.projectId !== p.projectId)
        throw new SuriError("PATH_DENIED", "Select a discovered worktree.");
      return candidate;
    },
    /** workspace.select persistence after the awaited realpath. */
    workspaceSelectPut(
      candidate: { projectId: string; label: string },
      root: string,
    ): Data {
      const existing = store.list("workspace").find((w) => w.root === root);
      if (existing) return existing;
      const result = store.put("workspace", {
        id: randomUUID(),
        projectId: candidate.projectId,
        root,
        label: candidate.label,
        revision: 1,
      });
      publish("catalog", "catalog.workspace", result);
      return result;
    },
    terminalCreate(p: Data) {
      const w = store.get("workspace", requiredString(p, "workspaceId"));
      return resources.createTerminal(w.root, w.id, p.cols ?? 80, p.rows ?? 24);
    },
    terminalCommand(c: Command, p: Data) {
      return resources.terminal(c.type, p);
    },
  };
}
