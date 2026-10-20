import { realpath } from "node:fs/promises";
import { SuriError, type Data } from "../../../packages/protocol/src/index.js";
export function inspectImportHeader(file: Buffer): Data {
  if (file.length > 32 * 1048576)
    throw new SuriError("LIMIT_EXCEEDED", "History import is too large.");
  try {
    const header = JSON.parse(
      file.subarray(0, 65536).toString().split("\n")[0],
    );
    if (
      header.type !== "session" ||
      header.version !== 3 ||
      typeof header.id !== "string" ||
      !/^[a-f0-9-]{36}$/i.test(header.id) ||
      typeof header.cwd !== "string"
    )
      throw Error();
    return header;
  } catch {
    throw new SuriError("VALIDATION", "This is not a compatible Pi history.");
  }
}
export async function importHeader(file: Buffer, root: string): Promise<Data> {
  try {
    const header = inspectImportHeader(file);
    if ((await realpath(header.cwd)) !== (await realpath(root))) throw Error();
    return header;
  } catch {
    throw new SuriError(
      "PATH_DENIED",
      "Imported history must match the selected workspace.",
    );
  }
}
