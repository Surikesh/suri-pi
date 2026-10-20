import type { Data } from "../../../packages/protocol/src/index.js";
import { token } from "./host-contract.js";
import type { Resources } from "./resources.js";
import type { Assets } from "./assets.js";
import type { Grants } from "./host-grants.js";
import type { HttpCaps } from "./host-http-types.js";
import type { RestartControlCaps } from "./host-control.js";
import type { HostRuntime } from "./host-runtime.js";
import type { Stream } from "./host-stream.js";
import type { Transport } from "./host-transport.js";
import type { WsCaps } from "./host-ws.js";
import type { HostOptions } from "./host-types.js";
import type { RetainedHosts } from "./retained-hosts.js";
import type { Storage } from "./storage.js";
import type { UiBuilds } from "./ui-builds.js";
import type { UpdateStatus } from "./update-status.js";

/**
 * Read-only lazy getters over host-owned lifetime state. They are closures,
 * never snapshots, so every read observes the value at the time it happens.
 */
export type HostLive = {
  origin: () => string;
  cookieName: () => string;
  closing: () => boolean;
  shutdownStage: () => string;
  modernUpdates: HttpCaps["modernUpdates"];
  lifecycle: HttpCaps["lifecycle"];
};

/** Builds the HTTP caps object; construction is synchronous and inert. */
export function httpCaps(
  live: HostLive,
  d: {
    options: HostOptions;
    assets: Assets;
    ui: UiBuilds;
    retainedHosts: RetainedHosts;
    launchIdentity: HttpCaps["launchIdentity"];
    instanceId: string;
    transport: Transport;
    grants: Grants;
    pureCommands: Set<string>;
    execute: HttpCaps["execute"];
    beginIngress: () => void;
    endIngress: () => void;
  },
): HttpCaps {
  return {
    root: d.options.root,
    assetsDir: d.options.assets,
    port: d.options.port,
    assets: d.assets,
    ui: d.ui,
    retainedHosts: d.retainedHosts,
    launchIdentity: d.launchIdentity,
    instanceId: d.instanceId,
    origin: live.origin,
    cookieName: live.cookieName,
    closing: live.closing,
    modernUpdates: live.modernUpdates,
    lifecycle: live.lifecycle,
    beginIngress: d.beginIngress,
    endIngress: d.endIngress,
    isPureCommand: (type) => d.pureCommands.has(type),
    execute: d.execute,
    auth: d.transport.auth,
    peek: d.transport.peek,
    takeNonce: d.transport.takeNonce,
    addNonce: d.transport.addNonce,
    addClient: d.transport.addClient,
    mintGrant: d.grants.mint,
  };
}

/** Builds the WebSocket caps object; construction is synchronous and inert. */
export function wsCaps(
  live: HostLive,
  d: {
    http: { onUpgrade: WsCaps["onUpgrade"] };
    transport: Transport;
    stream: Pick<
      Stream,
      "registerSocket" | "removeSocket" | "subscribe" | "unsubscribe"
    >;
    store: Storage;
    resources: Pick<Resources, "terminal">;
    catalog: WsCaps["catalog"];
  },
): WsCaps {
  return {
    onUpgrade: d.http.onUpgrade,
    origin: live.origin,
    auth: d.transport.auth,
    trackWs: d.transport.trackWs,
    live: d.transport.live,
    terminalSnapshot: (terminalId) =>
      d.resources.terminal("terminal.attach", { terminalId }) as Data,
    untrackWs: d.transport.untrackWs,
    registerSocket: d.stream.registerSocket,
    removeSocket: d.stream.removeSocket,
    subscribe: d.stream.subscribe,
    unsubscribe: d.stream.unsubscribe,
    store: d.store,
    modernUpdates: live.modernUpdates,
    catalog: d.catalog,
  };
}

/** Builds the control caps object; host keeps counter and closing setters. */
export function buildControlCaps(
  live: HostLive,
  d: {
    launchIdentity: RestartControlCaps["launchIdentity"];
    instanceId: string;
    hostRuntime: Pick<HostRuntime, "childCount">;
    activeWork: () => number;
    protectedWork: RestartControlCaps["protectedWork"];
    unresolvedCompletions: () => number;
    transport: Transport;
    grants: Grants;
    options: RestartControlCaps["options"];
    store: Storage;
    updateStatus: UpdateStatus;
    ui: UiBuilds;
    idle: RestartControlCaps["idle"];
    close: RestartControlCaps["close"];
    setClosing: RestartControlCaps["setClosing"];
    beginUpdateControl: () => void;
    endUpdateControl: () => void;
  },
): RestartControlCaps {
  return {
    closing: live.closing,
    setClosing: d.setClosing,
    origin: live.origin,
    shutdownStage: live.shutdownStage,
    modernUpdates: live.modernUpdates,
    lifecycle: live.lifecycle,
    launchIdentity: d.launchIdentity,
    instanceId: d.instanceId,
    childCount: d.hostRuntime.childCount,
    activeWork: d.activeWork,
    protectedWork: d.protectedWork,
    unresolvedCompletions: d.unresolvedCompletions,
    token,
    transport: d.transport,
    grants: d.grants,
    options: d.options,
    store: d.store,
    updateStatus: d.updateStatus,
    idle: d.idle,
    close: d.close,
    beginUpdateControl: d.beginUpdateControl,
    endUpdateControl: d.endUpdateControl,
    setUiCheckout: (path: string) => {
      d.ui.checkout = path;
    },
  };
}
