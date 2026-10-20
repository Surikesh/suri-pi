import { viewStorage as localStorage } from "../view-storage.js";
import type {
  Data,
  Projection,
} from "../../../../packages/protocol/src/index.js";
export type State = {
  connected: boolean;
  ready: boolean;
  catalog: Data;
  projections: Record<string, Projection>;
  error?: string;
  selected?: string;
  hostEpoch?: string;
};
let state: State = {
  connected: false,
  ready: false,
  catalog: { projects: [], workspaces: [], sessions: [], runtimes: [] },
  projections: {},
  selected: localStorage.getItem("suri.selected") ?? undefined,
};
const listeners = new Set<() => void>();
let csrf = "";
let clientId = "";
let socket: WebSocket | undefined;
let catalogLoaded = false;
let catalogRefresh = 0;
export const earlyResults = new Map<
  string,
  { status: string; error?: { message: string }; result?: Data }
>();
export const pending = new Map<
  string,
  {
    resolve: (v: Data) => void;
    reject: (e: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }
>();
export const store = {
  subscribe: (fn: () => void) => {
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  },
  getSnapshot: () => state,
};
export function update(p: Partial<State>) {
  state = { ...state, ...p };
  for (const fn of listeners) fn();
}
export const draftRevisions = new Map<string, number>();
export const projectionHeads: Record<string, Projection> = {};
export const projectionEpochs: Record<string, string> = {};
let nativeReauthenticationRequested = false;
export function requestNativeReauthentication() {
  if (nativeReauthenticationRequested) return false;
  const bridge = window.webkit?.messageHandlers?.suri;
  if (!bridge) return false;
  nativeReauthenticationRequested = true;
  update({ error: undefined });
  bridge.postMessage({ type: "reauthenticate" });
  return true;
}
export async function authenticatedFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const response = await fetch(input, init);
  if (
    response.status === 401 &&
    (nativeReauthenticationRequested || requestNativeReauthentication())
  ) {
    // The native shell immediately reloads the same route with a fresh one-time
    // bootstrap nonce. Keep every rejected operation from surfacing a misleading
    // error while that navigation replaces this JavaScript context.
    return await new Promise<Response>(() => undefined);
  }
  return response;
}
export const getState = () => state;
export const getCsrf = () => csrf;
export const setCsrf = (value: string) => {
  csrf = value;
};
export const getClientId = () => clientId;
export const setClientId = (value: string) => {
  clientId = value;
};
export const getSocket = () => socket;
export const setSocket = (value: WebSocket | undefined) => {
  socket = value;
};
export const isCatalogLoaded = () => catalogLoaded;
export const setCatalogLoaded = (value: boolean) => {
  catalogLoaded = value;
};
export const getCatalogRefresh = () => catalogRefresh;
export const bumpCatalogRefresh = () => ++catalogRefresh;
export const isNativeReauthenticationRequested = () =>
  nativeReauthenticationRequested;
export const clearNativeReauthentication = () => {
  nativeReauthenticationRequested = false;
};
