import { spawn } from "node:child_process";
import { SuriError } from "../../../packages/protocol/src/index.js";
export async function acquireLock(helper: string, path: string) {
  for (let attempt = 0; attempt < 10; attempt++) {
    const child = spawn(helper, ["lock", path], {
      stdio: ["pipe", "pipe", "ignore"],
    });
    const result = await new Promise<"locked" | "busy">((resolve, reject) => {
      child.stdout.once("data", () => resolve("locked"));
      child.once("error", () =>
        reject(
          new SuriError("CONFLICT", "Host locking helper is unavailable."),
        ),
      );
      child.once("exit", () => resolve("busy"));
    });
    if (result === "locked") return child;
    if (attempt < 9) await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new SuriError(
    "CONFLICT",
    "Another Suri host owns this data directory.",
  );
}
