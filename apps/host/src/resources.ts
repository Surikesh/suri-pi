import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { SuriError, type Data } from "../../../packages/protocol/src/index.js";
import * as pty from "node-pty";
const exec = promisify(execFile);
type SystemRunner = (file: string, args: string[]) => Promise<unknown>;
import { safePath } from "./resource-path.js";
export { safePath } from "./resource-path.js";
export { acquireLock } from "./resource-lock.js";
const TERMINAL_KILL_GRACE_MS = 1000;
export class Resources {
  terminals = new Map<
    string,
    {
      pty: pty.IPty;
      buffer: Buffer;
      cursor: number;
      seen: Set<string>;
      workspaceId: string;
      state: string;
      exited: Promise<void>;
      resolveExit: () => void;
      killTimer?: NodeJS.Timeout;
    }
  >();
  get activeTerminalCount() {
    return [...this.terminals.values()].filter(
      (item) => item.state !== "exited",
    ).length;
  }
  constructor(
    readonly helper: string,
    private emit: (id: string, type: string, p: Data) => void,
    private systemRunner: SystemRunner = (file, args) => exec(file, args),
    private platform = process.platform,
    private spawnPty: typeof pty.spawn = pty.spawn,
  ) {}
  async file(
    root: string,
    path: string,
    list: boolean,
    offset = 0,
    length = 1048576,
  ) {
    safePath(path);
    const want = Math.min(length, 1048576);
    try {
      const { stdout: raw } = await exec(
        this.helper,
        [
          list ? "list" : "read",
          root,
          path,
          String(offset),
          // Read one lookahead byte so EOF is not mistaken for truncation.
          String(list || want < 1 ? want : want + 1),
        ],
        { encoding: "buffer", maxBuffer: 2 * 1048576, timeout: 5000 },
      );
      const stdout = list ? raw : raw.subarray(0, want);
      if (list) {
        const parts = stdout.toString().split("\0").filter(Boolean);
        return {
          entries: parts.slice(0, 500).map((x) => ({
            name: x.slice(1),
            kind:
              x[0] === "d" ? "directory" : x[0] === "l" ? "symlink" : "file",
          })),
          truncated: parts.length > 500,
          cursor: parts.length > 500 ? String(offset + 500) : undefined,
        };
      }
      const binary =
        stdout.includes(0) ||
        !Buffer.from(stdout.toString("utf8")).equals(stdout);
      return {
        encoding: binary ? "base64" : "utf8",
        content: stdout.toString(binary ? "base64" : "utf8"),
        bytes: stdout.length,
        truncated: raw.length > want,
        revision: createHash("sha256").update(stdout).digest("hex"),
      };
    } catch {
      throw new SuriError(
        "PATH_DENIED",
        "The path is unavailable or contains a symbolic link.",
      );
    }
  }
  async writeFile(
    root: string,
    path: string,
    content: string,
    expectedRevision: string,
  ) {
    safePath(path);
    const bytes = Buffer.from(content, "utf8");
    if (bytes.length > 1048576)
      throw new SuriError(
        "LIMIT_EXCEEDED",
        "Editable files must be UTF-8 text no larger than 1 MiB.",
      );
    const current = await this.file(root, path, false, 0, 1048576);
    if (
      current.encoding !== "utf8" ||
      current.truncated ||
      current.revision !== expectedRevision
    )
      throw new SuriError(
        "CONFLICT",
        "The file changed on disk. Reopen it before saving your edits.",
      );
    await new Promise<void>((resolve, reject) => {
      const child = spawn(this.helper, ["write", root, path], {
        stdio: ["pipe", "ignore", "ignore"],
      });
      child.once("error", () =>
        reject(new SuriError("PATH_DENIED", "The file could not be saved.")),
      );
      child.once("exit", (code) => {
        if (code === 0) resolve();
        else
          reject(
            new SuriError(
              code === 7 ? "CONFLICT" : "PATH_DENIED",
              code === 7
                ? "The file changed on disk. Reopen it before saving your edits."
                : "The file could not be saved.",
            ),
          );
      });
      child.stdin.end(bytes);
    });
    return this.file(root, path, false, 0, 1048576);
  }
  async systemFile(
    root: string,
    path: string,
    action: "open" | "openWith" | "reveal",
  ) {
    safePath(path);
    await this.file(root, path, false, 0, 1);
    const target = join(root, path);
    try {
      if (this.platform === "darwin") {
        if (action === "open")
          await this.systemRunner("/usr/bin/open", [target]);
        else if (action === "reveal")
          await this.systemRunner("/usr/bin/open", ["-R", target]);
        else
          await this.systemRunner("/usr/bin/osascript", [
            "-e",
            "on run argv",
            "-e",
            'set chosenApplication to choose application with prompt "Open file with:"',
            "-e",
            "tell chosenApplication to open POSIX file (item 1 of argv)",
            "-e",
            "end run",
            target,
          ]);
      } else if (this.platform === "linux") {
        await this.systemRunner("/usr/bin/xdg-open", [
          action === "reveal" ? root : target,
        ]);
      } else {
        throw new Error("unsupported platform");
      }
    } catch {
      throw new SuriError(
        "CANCELLED",
        action === "openWith"
          ? "No application was selected."
          : "The desktop could not open this workspace file.",
      );
    }
    return { opened: true };
  }
  async git(root: string, type: string, p: Data) {
    const base = [
      "-c",
      "core.fsmonitor=false",
      "-c",
      "diff.external=",
      "-C",
      root,
    ];
    let args: string[];
    if (type === "git.status") args = ["status", "--porcelain=v2", "-z"];
    else if (type === "workspace.list")
      args = ["worktree", "list", "--porcelain", "-z"];
    else
      args = [
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        ...(p.staged ? ["--cached"] : []),
        "--",
        ...(p.path ? [safePath(p.path)] : []),
      ];
    try {
      const { stdout } = await exec("/usr/bin/git", [...base, ...args], {
        env: {
          ...process.env,
          GIT_OPTIONAL_LOCKS: "0",
          GIT_CONFIG_NOSYSTEM: "1",
        },
        timeout: 5000,
        maxBuffer: 1048576,
      });
      return { text: stdout };
    } catch {
      throw new SuriError(
        "NOT_FOUND",
        "Git information is unavailable for this workspace.",
      );
    }
  }
  createTerminal(
    root: string,
    workspaceId: string,
    cols: number,
    rows: number,
  ) {
    const workspaceTerminals = [...this.terminals.values()].filter(
      (terminal) =>
        terminal.workspaceId === workspaceId && terminal.state !== "exited",
    ).length;
    if (workspaceTerminals >= 4)
      throw new SuriError(
        "LIMIT_EXCEEDED",
        "Close a terminal in this workspace first.",
      );
    this.dimensions(cols, rows);
    const id = randomUUID();
    const shell = this.platform === "darwin" ? "/bin/zsh" : "/bin/bash";
    const child = this.spawnPty(
      shell,
      this.platform === "darwin" ? ["-i"] : ["--noprofile", "--norc", "-i"],
      {
        cwd: root,
        cols,
        rows,
        env: {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          HOME: process.env.HOME ?? root,
          TERM: "xterm-256color",
          LANG: "en_US.UTF-8",
        },
        name: "xterm-256color",
      },
    );
    let resolveExit!: () => void;
    const exited = new Promise<void>((resolve) => {
      resolveExit = resolve;
    });
    const t: NonNullable<ReturnType<typeof this.terminals.get>> = {
      pty: child,
      buffer: Buffer.alloc(0),
      cursor: 0,
      seen: new Set<string>(),
      workspaceId,
      state: "running",
      exited,
      resolveExit,
    };
    this.terminals.set(id, t);
    child.onData((data) => {
      t.cursor += Buffer.byteLength(data);
      t.buffer = Buffer.concat([t.buffer, Buffer.from(data)]).subarray(
        -1048576,
      );
      this.emit(id, "terminal.output", {
        terminalId: id,
        cursor: t.cursor,
        data: Buffer.from(data).toString("base64"),
      });
    });
    child.onExit(({ exitCode }) => {
      t.state = "exited";
      if (t.killTimer) clearTimeout(t.killTimer);
      t.resolveExit();
      this.emit(id, "terminal.state", {
        terminalId: id,
        phase: "exited",
        exitCode,
      });
    });
    return { terminalId: id };
  }
  terminal(type: string, p: Data) {
    const t = this.terminals.get(p.terminalId);
    if (!t)
      throw new SuriError("NOT_FOUND", "Terminal is no longer available.");
    switch (type) {
      case "terminal.attach":
        return {
          terminalId: p.terminalId,
          cursor: t.cursor,
          data: t.buffer.toString("base64"),
          phase: t.state,
        };
      case "terminal.input":
        if (
          typeof p.inputId !== "string" ||
          typeof p.data !== "string" ||
          p.data.length > 65536
        )
          throw new SuriError("VALIDATION", "Invalid terminal input.");
        if (!t.seen.has(p.inputId)) {
          t.seen.add(p.inputId);
          if (t.seen.size > 10000) t.seen.delete(t.seen.values().next().value!);
          t.pty.write(p.data);
        }
        break;
      case "terminal.resize":
        this.dimensions(p.cols, p.rows);
        t.pty.resize(p.cols, p.rows);
        break;
      case "terminal.close":
        if (t.state !== "exited") {
          this.stop(t);
        }
        break;
    }
    return {};
  }
  // SIGHUP first; a shell that ignores it (e.g. still starting up) gets SIGKILL after a grace.
  // Only the shell is signalled: descendants that ignore SIGHUP or detach can outlive it.
  private stop(t: {
    pty: pty.IPty;
    state: string;
    killTimer?: NodeJS.Timeout;
  }) {
    t.state = "stopping";
    t.pty.kill();
    // Repeated closes keep the first deadline instead of postponing SIGKILL.
    if (t.killTimer) return;
    t.killTimer = setTimeout(() => {
      try {
        t.pty.kill("SIGKILL");
      } catch {
        // already gone
      }
    }, TERMINAL_KILL_GRACE_MS);
  }
  private dimensions(cols: number, rows: number) {
    if (
      !Number.isInteger(cols) ||
      cols < 2 ||
      cols > 500 ||
      !Number.isInteger(rows) ||
      rows < 1 ||
      rows > 300
    )
      throw new SuriError("VALIDATION", "Invalid terminal dimensions.");
  }
  async closeAndWait(timeoutMs = 5000) {
    const exits: Promise<void>[] = [];
    for (const t of this.terminals.values()) {
      if (t.state !== "exited") {
        exits.push(t.exited);
        this.stop(t);
      }
    }
    if (exits.length) {
      let timer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          Promise.all(exits),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(
              () =>
                reject(
                  new SuriError(
                    "TERMINAL_SHUTDOWN_TIMEOUT",
                    "A workspace terminal did not stop in time.",
                    true,
                  ),
                ),
              timeoutMs,
            );
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
    this.terminals.clear();
  }
  close() {
    void this.closeAndWait();
  }
}
