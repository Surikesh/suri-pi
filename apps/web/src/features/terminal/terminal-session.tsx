import { useCallback, useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { command, subscribe, report, store } from "../../store.js";
import type { Pane } from "./layout.js";

export function TerminalSession({
  workspaceId,
  pane,
  active,
  execution,
  onReady,
  onActivate,
  onExecutionHandled,
}: {
  workspaceId: string;
  pane: Pane;
  active: boolean;
  execution?: { id: string; command: string };
  onReady: (paneId: string, terminalId: string) => void;
  onActivate: () => void;
  onExecutionHandled?: (id: string) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const fitRef = useRef<FitAddon | undefined>(undefined);
  const activeId = useRef(pane.terminalId);
  const [phase, setPhase] = useState("Connecting");
  const [error, setError] = useState("");
  const [generation, setGeneration] = useState(0);

  const restart = useCallback(() => {
    const terminalId = activeId.current;
    void (
      terminalId
        ? // Best effort: the terminal may already be closed; the restart proceeds either way.
          command("terminal.close", { terminalId }).catch(() => {})
        : Promise.resolve()
    ).then(() => {
      activeId.current = undefined;
      setError("");
      setGeneration((value) => value + 1);
    });
  }, []);

  useEffect(() => {
    setPhase("Connecting");
    setError("");
    let terminalId = activeId.current;
    let dead = false;
    let attached = false;
    let cursor = 0;
    let resizeFrame = 0;
    let lastSize = "";
    const pending: { data: string; cursor: number }[] = [];
    const term = new Terminal({
      fontSize: 12,
      lineHeight: 1.18,
      fontFamily: "Menlo, Monaco, monospace",
      scrollback: 10000,
      cursorBlink: true,
      theme: {
        background: "#f7f8fb",
        foreground: "#252933",
        cursor: "#5365ad",
        selectionBackground: "#5266b833",
        black: "#343846",
        red: "#b63e48",
        green: "#31784e",
        yellow: "#8d6917",
        blue: "#386bb0",
        magenta: "#8954ac",
        cyan: "#257e8a",
        white: "#727888",
        brightBlack: "#858b99",
        brightRed: "#c34751",
        brightGreen: "#37834d",
        brightYellow: "#987414",
        brightBlue: "#497dc4",
        brightMagenta: "#9964bb",
        brightCyan: "#288c96",
        brightWhite: "#252933",
      },
      allowProposedApi: false,
      screenReaderMode: true,
    });
    const fit = new FitAddon();
    fitRef.current = fit;
    term.loadAddon(fit);
    term.open(ref.current!);
    term.parser.registerOscHandler(52, () => true);
    const write = (payload: { data: string; cursor: number }) => {
      const bytes = Uint8Array.from(atob(payload.data), (c) => c.charCodeAt(0));
      const start = payload.cursor - bytes.length;
      const skip = Math.max(0, cursor - start);
      if (payload.cursor > cursor) term.write(bytes.subarray(skip));
      cursor = Math.max(cursor, payload.cursor);
    };
    const resizeTerminal = () => {
      if (dead || !ref.current?.clientWidth || !ref.current?.clientHeight)
        return;
      fit.fit();
      const size = `${term.cols}:${term.rows}`;
      if (terminalId && size !== lastSize) {
        lastSize = size;
        void command("terminal.resize", {
          terminalId,
          cols: term.cols,
          rows: term.rows,
        }).catch(report);
      }
    };
    const attach = async () => {
      if (!terminalId) {
        fit.fit();
        const result = await command("terminal.create", {
          workspaceId,
          cols: term.cols,
          rows: term.rows,
        });
        terminalId = result.terminalId;
        if (dead) {
          // Best effort: the terminal may already be closed; this session has been disposed.
          await command("terminal.close", { terminalId }).catch(() => {});
          return;
        }
        activeId.current = terminalId;
        onReady(pane.id, terminalId!);
      }
      if (dead) return;
      subscribe(`terminal:${terminalId}`);
      const history = await command("terminal.attach", { terminalId });
      write({ data: history.data, cursor: history.cursor });
      setPhase(history.phase === "running" ? "Running" : "Exited");
      attached = true;
      resizeTerminal();
      pending.forEach(write);
      pending.length = 0;
    };
    const listener = (event: Event) => {
      const detail = (event as CustomEvent).detail;
      if (detail.payload.terminalId !== terminalId) return;
      if (detail.type === "terminal.state")
        setPhase(`Exited (${detail.payload.exitCode ?? 0})`);
      if (detail.type === "terminal.output") {
        if (attached) write(detail.payload);
        else pending.push(detail.payload);
      }
    };
    window.addEventListener("suri-terminal", listener);
    void attach().catch((reason) => {
      setError(reason instanceof Error ? reason.message : String(reason));
      setPhase("Unavailable");
    });
    let inputChain = Promise.resolve<unknown>(undefined);
    let inputFailed = false;
    term.onData((data) => {
      if (inputFailed || !terminalId) return;
      inputChain = inputChain
        .then(() =>
          command("terminal.input", {
            terminalId,
            inputId: crypto.randomUUID(),
            data,
          }),
        )
        .catch((reason) => {
          inputFailed = true;
          report(reason);
        });
    });
    let connected = store.getSnapshot().connected;
    const unsubscribe = store.subscribe(() => {
      const next = store.getSnapshot().connected;
      if (!next) setPhase("Disconnected");
      if (next && !connected && terminalId) {
        subscribe(`terminal:${terminalId}`);
        void command("terminal.attach", { terminalId })
          .then((history) => {
            write({ data: history.data, cursor: history.cursor });
            setPhase(history.phase === "running" ? "Running" : "Exited");
          })
          .catch((reason) => setError(reason.message));
      }
      connected = next;
    });
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(resizeFrame);
      resizeFrame = requestAnimationFrame(resizeTerminal);
    });
    ro.observe(ref.current!);
    return () => {
      dead = true;
      ro.disconnect();
      cancelAnimationFrame(resizeFrame);
      unsubscribe();
      window.removeEventListener("suri-terminal", listener);
      term.dispose();
      fitRef.current = undefined;
    };
  }, [generation, onReady, pane.id, workspaceId]);

  useEffect(() => {
    const listener = (event: Event) => {
      if ((event as CustomEvent).detail?.paneId === pane.id) restart();
    };
    window.addEventListener("suri-restart-terminal", listener);
    return () => window.removeEventListener("suri-restart-terminal", listener);
  }, [pane.id, restart]);

  useEffect(() => {
    if (!active) return;
    requestAnimationFrame(() => {
      try {
        fitRef.current?.fit();
      } catch {
        // A hidden group may not be measurable until its next resize observation.
      }
    });
  }, [active]);

  useEffect(() => {
    if (!execution || !activeId.current || !active) return;
    if (phase.startsWith("Exited")) {
      restart();
      return;
    }
    if (phase !== "Running") return;
    void command("terminal.input", {
      terminalId: activeId.current,
      inputId: execution.id,
      data: `${execution.command.trimEnd()}\r`,
    })
      .then(() => onExecutionHandled?.(execution.id))
      .catch(report);
  }, [active, execution, onExecutionHandled, phase, restart]);

  return (
    <section
      className={`terminal-session${active ? " active" : ""}`}
      aria-label={`${pane.title} terminal · ${error || phase}`}
      onPointerDown={onActivate}
    >
      {(error || phase !== "Running") && (
        <span className="terminal-phase-overlay">{error || phase}</span>
      )}
      <div ref={ref} className="terminal" />
    </section>
  );
}
