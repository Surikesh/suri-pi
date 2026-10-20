import { spawn } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { closeAndRetire } from "../../apps/host/src/runtime-exit.js";

const children: Array<ReturnType<typeof spawn>> = [];

function stubborn(script: string) {
  const child = spawn(process.execPath, ["-e", script], {
    detached: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  children.push(child);
  const exited = new Promise<void>((resolve) => child.once("exit", resolve));
  return {
    child,
    exited,
    close: () => {
      // Stdin EOF is deliberately ignored by the child.
      child.stdin!.end();
    },
  } as any;
}

afterEach(() => {
  for (const child of children.splice(0))
    if (child.pid && child.exitCode === null)
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        // Already gone.
      }
});

const ready = (child: ReturnType<typeof spawn>) =>
  new Promise<void>((resolve) => child.stdout!.once("data", () => resolve()));

describe("bounded runtime exit", () => {
  it("escalates to SIGKILL for a child that ignores stdin EOF and SIGTERM", async () => {
    const runtime = stubborn(
      "process.on('SIGTERM',()=>{});console.log('up');setInterval(()=>{},1000)",
    );
    await ready(runtime.child);
    await closeAndRetire(runtime, 100, 200);
    expect(runtime.child.signalCode).toBe("SIGKILL");
  });

  it("stops at SIGTERM when that is enough", async () => {
    const runtime = stubborn("console.log('up');setInterval(()=>{},1000)");
    await ready(runtime.child);
    await closeAndRetire(runtime, 100, 1000);
    expect(runtime.child.signalCode).toBe("SIGTERM");
  });

  it("fails explicitly when the child never reports an exit", async () => {
    const runtime = stubborn("console.log('up');setInterval(()=>{},1000)");
    await ready(runtime.child);
    runtime.exited = new Promise<void>(() => undefined);
    await expect(closeAndRetire(runtime, 50, 50)).rejects.toMatchObject({
      code: "RUNTIME_EXIT_TIMEOUT",
    });
  });
});
