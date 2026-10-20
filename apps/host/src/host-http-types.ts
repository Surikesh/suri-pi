import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type { Command, Receipt } from "../../../packages/protocol/src/index.js";
import type { Assets } from "./assets.js";
import type { UiBuilds } from "./ui-builds.js";
import type { ModernUpdates } from "./modern-updates.js";
import type { RetainedHosts } from "./retained-hosts.js";
import type { createRestartLifecycle } from "./restart-lifecycle.js";
import type { Grants } from "./host-grants.js";
import type { Transport } from "./host-transport.js";
export type HttpCaps = {
  root: string;
  assetsDir: string;
  port: number | undefined;
  assets: Assets;
  ui: UiBuilds;
  retainedHosts: RetainedHosts;
  launchIdentity: Readonly<{ buildId: string; adapterId: string }> | undefined;
  instanceId: string;
  origin: () => string;
  cookieName: () => string;
  closing: () => boolean;
  modernUpdates: () => ModernUpdates | undefined;
  lifecycle: () =>
    Awaited<ReturnType<typeof createRestartLifecycle>> | undefined;
  beginIngress: () => void;
  endIngress: () => void;
  isPureCommand: (type: string) => boolean;
  execute: (c: Command, clientId: string) => Promise<Receipt>;
  auth: Transport["auth"];
  peek: Transport["peek"];
  takeNonce: Transport["takeNonce"];
  addNonce: Transport["addNonce"];
  addClient: Transport["addClient"];
  mintGrant: Grants["mint"];
};
export type UpgradeListener = (
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
) => void;
