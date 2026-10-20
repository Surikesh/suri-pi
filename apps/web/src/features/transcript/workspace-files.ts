import { serviceNames } from "../../domain/presentation.js";
import { command } from "../../store.js";

export async function findWorkspaceFiles(workspaceId: string, query: string) {
  const directories = ["."];
  const matches: string[] = [];
  let inspected = 0;
  const needle = query.toLowerCase();
  while (directories.length && inspected < 2000 && matches.length < 50) {
    const directory = directories.shift()!;
    let cursor: string | undefined;
    do {
      const result = await command("file.list", {
        workspaceId,
        path: directory,
        ...(cursor ? { cursor } : {}),
      });
      for (const entry of result.entries ?? []) {
        inspected++;
        if (entry.name.startsWith(".") || serviceNames.has(entry.name))
          continue;
        const path =
          directory === "." ? entry.name : `${directory}/${entry.name}`;
        if (entry.kind === "directory") directories.push(path);
        else if (entry.kind === "file" && path.toLowerCase().includes(needle))
          matches.push(path);
        if (inspected >= 2000 || matches.length >= 50) break;
      }
      cursor = result.cursor;
    } while (cursor && inspected < 2000 && matches.length < 50);
  }
  return matches.sort((a, b) => a.localeCompare(b));
}
