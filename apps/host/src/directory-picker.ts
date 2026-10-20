import { randomUUID } from "node:crypto";
import { mkdir, opendir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import { SuriError } from "../../../packages/protocol/src/index.js";

// Only directory metadata crosses this boundary. Selection is explicit, short
// lived, client-bound and revalidated before existing catalog commands use it.
export class DirectoryPicker {
  constructor(private readonly home = homedir()) {}
  private selections = new Map<
    string,
    {
      path: string;
      clientId: string;
      expires: number;
      dev: number;
      ino: number;
    }
  >();

  async list(clientId: string, requested?: string) {
    for (const [id, item] of this.selections)
      if (item.expires < Date.now()) this.selections.delete(id);
    if (this.selections.size > 256)
      this.selections.delete(this.selections.keys().next().value!);
    let path = requested?.trim() || this.home;
    if (path === "~" || path.startsWith("~/"))
      path = join(this.home, path.slice(2));
    if (!isAbsolute(path) || path.length > 4096)
      throw new SuriError("VALIDATION", "Enter an absolute folder path.");
    try {
      path = await realpath(path);
      const info = await stat(path);
      if (!info.isDirectory()) throw Error("not a directory");
      const entries: { name: string; path: string }[] = [];
      let truncated = false;
      let scanned = 0;
      for await (const entry of await opendir(path)) {
        if (++scanned > 10000 || entries.length >= 1000) {
          truncated = true;
          break;
        }
        if (entry.isDirectory())
          entries.push({ name: entry.name, path: join(path, entry.name) });
      }
      entries.sort((a, b) =>
        a.name.localeCompare(b.name, undefined, { numeric: true }),
      );
      const selectionId = randomUUID();
      this.selections.set(selectionId, {
        path,
        clientId,
        expires: Date.now() + 10 * 60 * 1000,
        dev: info.dev,
        ino: info.ino,
      });
      return { path, parent: dirname(path), entries, selectionId, truncated };
    } catch {
      throw new SuriError(
        "PATH_DENIED",
        "This folder is unavailable or cannot be read. Choose another folder.",
      );
    }
  }

  async create(clientId: string, requested: string) {
    let path = requested.trim();
    if (path === "~" || path.startsWith("~/"))
      path = join(this.home, path.slice(2));
    if (!isAbsolute(path) || path.length > 4096)
      throw new SuriError("VALIDATION", "Enter an absolute folder path.");

    const parent = dirname(path);
    if (parent === path)
      throw new SuriError("VALIDATION", "Enter a name for the new folder.");
    try {
      const resolvedParent = await realpath(parent);
      const parentInfo = await stat(resolvedParent);
      if (!parentInfo.isDirectory()) throw Error("parent is not a directory");
      const target = join(resolvedParent, basename(path));
      await mkdir(target, { mode: 0o700 });
      return await this.list(clientId, target);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "EEXIST")
        return await this.list(clientId, path);
      throw new SuriError(
        "PATH_DENIED",
        "This folder could not be created. Check its name and parent folder permissions.",
      );
    }
  }

  async consume(clientId: string, id: string) {
    const item = this.selections.get(id);
    if (!item || item.clientId !== clientId || item.expires < Date.now())
      throw new SuriError(
        "PATH_DENIED",
        "Choose the folder again before opening it.",
      );
    this.selections.delete(id);
    try {
      const path = await realpath(item.path);
      const info = await stat(path);
      if (
        path !== item.path ||
        !info.isDirectory() ||
        info.dev !== item.dev ||
        info.ino !== item.ino
      )
        throw Error("changed");
      return path;
    } catch {
      throw new SuriError(
        "PATH_DENIED",
        "The folder changed or was removed. Choose it again.",
      );
    }
  }
}
