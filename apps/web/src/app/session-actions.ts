import type { Data } from "../../../../packages/protocol/src/index.js";
import { command, refresh, report, select, type State } from "../store.js";
import type {
  ComposerStateValue,
  DialogState,
  ShellState,
} from "./use-app-state.js";
import type { SessionView } from "./use-session-view.js";

export function createSessionActions({
  state,
  session,
  workspace,
  projection,
  running,
  shell,
  dialogs,
  composerState,
}: {
  state: State;
  session: SessionView["session"];
  workspace: SessionView["workspace"];
  projection: SessionView["projection"];
  running: boolean;
  shell: ShellState;
  dialogs: DialogState;
  composerState: ComposerStateValue;
}) {
  const { focusNewSession, editor, setSidebar } = shell;
  const { setDirectoryDialog } = dialogs;
  const { draft, attachments } = composerState;
  const act = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      await refresh();
    } catch (e) {
      report(e);
    }
  };
  const create = async (workspaceId?: string) => {
    const w = workspaceId ?? workspace?.id ?? state.catalog.workspaces[0]?.id;
    if (
      session &&
      session.name === "New session" &&
      session.workspaceId === w &&
      projection.messages.length === 0 &&
      !draft.trim() &&
      attachments.length === 0 &&
      !running
    ) {
      focusNewSession.current = session.id;
      requestAnimationFrame(() => editor.current?.focus());
      setSidebar(false);
      return;
    }
    const runtime =
      state.catalog.runtimes.find((r: Data) => r.status === "verified") ??
      state.catalog.runtimes[0];
    if (!w) {
      setDirectoryDialog(null);
      return;
    }
    if (!runtime)
      throw Error("Register and verify an installed Pi runtime first.");
    const r = await command("session.create", {
      workspaceId: w,
      runtimeId: runtime.id,
    });
    focusNewSession.current = r.id;
    select(r.id);
    setSidebar(false);
  };
  return { act, create };
}
