import type { z } from "zod";
import { UpdateCommandPayloads } from "../../../packages/protocol/src/update-commands.js";
import { UpdateTransitionFailure } from "./update-coordinator.js";

export type Window = {
  auth: string;
  seen: number;
  surface: "browser" | "native";
  loadedUiId: string | null;
  mode: "follow" | "pinned";
  target: string | null;
  shellContract: number;
};
type OpenRequest = {
  client: string;
  finish: (checkpointed: boolean) => void;
};
type ClientInput = z.infer<(typeof UpdateCommandPayloads)["updates.client"]>;

/**
 * Sole owner of the window and open-request maps. Operations never hand the
 * maps (or their iterators) to callers.
 */
export function createModernWindows() {
  const openRequests = new Map<string, OpenRequest>();
  const windows = new Map<string, Window>();
  return {
    requestBrowserOpen(client: string): Promise<boolean> {
      const window = windows.get(client);
      if (
        !window ||
        window.surface !== "browser" ||
        Date.now() - window.seen >= 45000
      )
        return Promise.resolve(false);
      const requestId = crypto.randomUUID();
      return new Promise((resolve) => {
        const timer = setTimeout(() => finish(false), 4000);
        const finish = (checkpointed: boolean) => {
          clearTimeout(timer);
          openRequests.delete(requestId);
          resolve(checkpointed);
        };
        openRequests.set(requestId, { client, finish });
      });
    },
    onlineClients() {
      return [...windows]
        .filter(([, client]) => Date.now() - client.seen < 45_000)
        .map(([id]) => id);
    },
    finishAllOpenRequests() {
      for (const request of openRequests.values()) request.finish(false);
    },
    openRequest(requestId: string) {
      return openRequests.get(requestId);
    },
    browserOpen() {
      return [...openRequests].map(([requestId, request]) => ({
        requestId,
        clientInstanceId: request.client,
      }));
    },
    clients() {
      return [...windows.entries()].slice(-100).map(([instanceId, client]) => ({
        instanceId,
        surface: client.surface,
        loadedUiId: client.loadedUiId,
        mode: client.mode,
        targetId: client.target,
        online: Date.now() - client.seen < 45_000,
      }));
    },
    client(id: string, auth: string) {
      const client = windows.get(id);
      if (!client || client.auth !== auth || Date.now() - client.seen >= 45_000)
        throw new UpdateTransitionFailure("UNAUTHORIZED");
      return client;
    },
    /** `beforeSet` runs after admission checks and before the window is stored. */
    register(
      client: string,
      auth: string,
      input: ClientInput,
      beforeSet: () => void,
    ) {
      const previous = windows.get(client);
      if (previous && previous.auth !== auth)
        throw new UpdateTransitionFailure("UNAUTHORIZED");
      if (windows.size >= 100 && !previous) {
        for (const [key, value] of windows)
          if (Date.now() - value.seen >= 45_000) windows.delete(key);
        if (windows.size >= 100)
          throw new UpdateTransitionFailure("UPDATE_CONFLICT");
      }
      beforeSet();
      windows.set(client, {
        auth,
        seen: Date.now(),
        surface: input.surface,
        loadedUiId: input.loadedUiId,
        mode: previous?.mode ?? input.mode,
        target:
          previous?.target ??
          (input.mode === "pinned" ? input.loadedUiId : null),
        shellContract: input.shellContract ?? 1,
      });
    },
  };
}
export type ModernWindows = ReturnType<typeof createModernWindows>;
