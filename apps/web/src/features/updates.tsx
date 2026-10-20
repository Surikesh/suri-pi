import React, { useEffect, useState, useRef } from "react";
import type { UpdateCheckpoint } from "../../../../packages/protocol/src/update-checkpoint.js";
import type { Data } from "../../../../packages/protocol/src/index.js";

declare global {
  interface Window {
    suriUpdate?: {
      client: string;
      descriptor: { buildId: string; hostInstanceId: string };
      ready: boolean;
      exportSaved: () => Promise<void>;
      pin: () => Promise<void>;
      follow: () => Promise<void>;
      persist: (checkpoint: UpdateCheckpoint) => Promise<void>;
      command: (type: string, payload?: Data) => Promise<Data>;
      transition: (type: string, payload?: Data) => Promise<void>;
      reload: () => Promise<void>;
      descriptorCheckpoint?: UpdateCheckpoint;
    };
    suriReconnectRequired?: boolean;
    suriUploadsPending?: number;
    suriCheckpoint?: () => UpdateCheckpoint;
    suriViewReady?: () => boolean;
    suriRestore?: (checkpoint: UpdateCheckpoint | null) => Promise<void>;
    suriWatermarks?: () => { catalogSeq: number; sessionSeq?: number };
  }
}
export function UpdatesControl() {
  const [status, setStatus] = useState<Data>();
  const [error, setError] = useState("");
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const api = window.suriUpdate;
  const confirmation = useRef<HTMLDialogElement>(null);
  const [confirmTarget, setConfirmTarget] = useState<Data | null>(null);
  useEffect(() => {
    if (confirmTarget) confirmation.current?.showModal();
    else confirmation.current?.close();
  }, [confirmTarget]);
  useEffect(() => {
    if (!api) return;
    let disposed = false;
    const refresh = () =>
      void api
        .command("updates.get")
        .then((s) => {
          if (!disposed) setStatus(s);
        })
        // No error is shown while a restart marker is present in sessionStorage.
        .catch(() => {
          if (!disposed && !sessionStorage.getItem("suri.restart"))
            setError("Update status unavailable. Keep this window open.");
        });
    refresh();
    const timer = setInterval(refresh, 2000);
    const keyboard = (event: KeyboardEvent) => {
      if (
        (event.metaKey || event.ctrlKey) &&
        event.shiftKey &&
        event.code === "KeyR"
      ) {
        event.preventDefault();
        event.stopPropagation();
        void api
          .reload()
          .catch((failure) =>
            setError(
              failure instanceof Error &&
                failure.message === "CLIENT_STATE_UNSAVED"
                ? "Finish text composition or wait for the upload before updating. Your draft is retained."
                : "Interface update was refused. Open Updates for the current state.",
            ),
          );
      }
    };
    const openUpdates = () => setOpen(true);
    addEventListener("keydown", keyboard, true);
    addEventListener("suri-update-ready", refresh);
    addEventListener("suri-open-updates", openUpdates);
    return () => {
      disposed = true;
      clearInterval(timer);
      removeEventListener("keydown", keyboard, true);
      removeEventListener("suri-update-ready", refresh);
      removeEventListener("suri-open-updates", openUpdates);
    };
  }, [api]);
  if (!api) return null;
  const loaded = api.descriptor?.buildId;
  const self = status?.clients?.find(
    (client: Data) => client.instanceId === api.client,
  );
  const behind = status?.ui.activeId && status.ui.activeId !== loaded;
  const candidate = status?.available?.ui;
  const approval = status?.restart?.approval;
  const armed =
    approval &&
    ["waiting", "preflight", "checkpoints", "dispatching"].includes(
      approval.phase,
    );
  const sourceUnavailable = [
    status?.available?.ui,
    status?.available?.host,
  ].some(
    (item) => item?.state === "rejected" && item.code === "CHECKOUT_CHANGED",
  );
  const rejected = [status?.available?.ui, status?.available?.host].find(
    (item) => item?.state === "rejected",
  );
  const label = sourceUnavailable
    ? "Development source unavailable"
    : rejected
      ? "Update rejected"
      : armed
        ? "Will restart when work finishes"
        : !api.ready
          ? "Restoring interface…"
          : error
            ? "Update needs attention"
            : busy
              ? "Updating interface…"
              : self?.mode === "pinned"
                ? "Using pinned interface"
                : behind
                  ? "Interface changed · Reload"
                  : candidate?.state === "verified" &&
                      candidate.buildId !== loaded
                    ? "Interface update ready"
                    : status?.pendingHostId
                      ? "Host update ready"
                      : status?.available?.host?.buildId ===
                            status?.runningHost?.buildId &&
                          candidate?.buildId === loaded &&
                          loaded === status?.ui.activeId
                        ? "Up to date"
                        : "Update status";
  const action = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (failure) {
      const code =
        failure instanceof Error && /^[A-Z_]{1,80}$/.test(failure.message)
          ? failure.message
          : "UPDATE_FAILED";
      setError(
        `Update could not complete (${code}). Your draft is retained; no active work was stopped.`,
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="updates-control">
      <button
        aria-expanded={open}
        aria-busy={busy}
        aria-live="polite"
        onClick={() => setOpen(!open)}
      >
        {label}
      </button>
      {open && (
        <section className="updates-panel" aria-label="Updates">
          {error && <p role="alert">{error}</p>}
          {rejected && (
            <p role="status">
              {rejected.code}. The retained interface remains available.
            </p>
          )}
          <p>
            Loaded interface: <code>{loaded}</code>
          </p>
          <p>
            Active interface: <code>{status?.ui.activeId ?? "Unknown"}</code>
          </p>
          <p>
            Running host:{" "}
            <code>
              {status?.runningHost?.buildId ?? "Unknown legacy launch"}
            </code>
          </p>
          <p>
            Available host: <code>{status?.pendingHostId ?? "None"}</code>
          </p>
          <button
            disabled={busy}
            onClick={() => void action(() => api.reload())}
          >
            {self?.mode === "pinned"
              ? "Reload pinned interface"
              : candidate?.state === "verified" &&
                  candidate.buildId !== loaded &&
                  !behind
                ? "Use new interface"
                : "Reload UI"}
          </button>
          <button
            disabled={busy}
            onClick={() =>
              void action(() =>
                self?.mode === "pinned" ? api.follow() : api.pin(),
              )
            }
          >
            {self?.mode === "pinned"
              ? "Follow active interface"
              : "Pin this window to this interface"}
          </button>
          {status?.ui.previousKnownGoodId && (
            <button
              disabled={busy}
              onClick={() =>
                void action(() =>
                  api.transition("ui.rollback", { target: "previous" }),
                )
              }
            >
              Restore previous interface
            </button>
          )}
          <button
            disabled={busy}
            onClick={() =>
              void action(() =>
                api.transition("ui.rollback", { target: "packaged" }),
              )
            }
          >
            Use packaged interface
          </button>
          {status?.pendingHostId && (
            <>
              <p>
                Reloading the interface does not update the host. Restart
                requires idle work and explicit approval.
              </p>
              {status.restart?.work?.count > 0 && (
                <p role="status">
                  Waiting for protected work to finish (
                  {status.restart.work.count}).
                </p>
              )}
              {approval?.code && (
                <p role="status">Restart status: {approval.code}</p>
              )}
              {armed ? (
                <button
                  disabled={busy}
                  onClick={() =>
                    void action(() =>
                      api.command("host.restart.cancel", {
                        clientInstanceId: api.client,
                        operationId: approval.operationId,
                      }),
                    )
                  }
                >
                  Cancel scheduled restart
                </button>
              ) : status.runningHost?.buildId ? (
                <button
                  disabled={busy}
                  onClick={() =>
                    setConfirmTarget({
                      ...status.available.host,
                      mode: status.restart?.work?.count ? "when-idle" : "now",
                    })
                  }
                >
                  {status.restart?.work?.count
                    ? "Restart when idle"
                    : "Restart host"}
                </button>
              ) : (
                <p>
                  The legacy host must first be launched through the retained
                  local launcher.
                </p>
              )}
            </>
          )}
          <button disabled={busy} onClick={() => void action(api.exportSaved)}>
            Download saved window state
          </button>
          <button onClick={() => setOpen(false)}>Close updates</button>
        </section>
      )}
      <dialog
        ref={confirmation}
        aria-labelledby="restart-confirm-title"
        onCancel={() => setConfirmTarget(null)}
        onClose={() => setConfirmTarget(null)}
      >
        <h2 id="restart-confirm-title">
          {confirmTarget?.mode === "when-idle"
            ? "Restart once work finishes?"
            : "Restart the host?"}
        </h2>
        <p>
          Approve only this build: <code>{confirmTarget?.buildId}</code>. Active
          work will never be stopped. Window drafts are saved before restart.
        </p>
        <button autoFocus onClick={() => setConfirmTarget(null)}>
          Keep working
        </button>
        <button
          onClick={() => {
            const target = confirmTarget!;
            setConfirmTarget(null);
            void action(() =>
              api.command("host.restart.approve", {
                clientInstanceId: api.client,
                targetBuildId: target.buildId,
                generation: target.generation,
                mode: target.mode,
                confirm: true,
              }),
            );
          }}
        >
          Approve restart
        </button>
      </dialog>
    </div>
  );
}
