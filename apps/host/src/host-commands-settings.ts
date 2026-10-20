import {
  SuriError,
  type Command,
  type Data,
} from "../../../packages/protocol/src/index.js";
import type { Storage } from "./storage.js";

/** Synchronous preference and draft command bodies. */
export function createSettingsCommands(caps: { store: Storage }) {
  const { store } = caps;
  return {
    preferencesGet(): Data {
      let result: Data = {};
      result = store.list("preferences")[0] ?? {
        id: "preferences",
        revision: 0,
        values: { theme: "light", sidebarWidth: 232, detailsWidth: 360 },
      };
      return result;
    },
    preferencesPatch(c: Command, p: Data): Data {
      let result: Data = {};
      const old = store.list("preferences")[0] ?? {
        id: "preferences",
        revision: 0,
        values: { theme: "light" },
      };
      if (old.revision !== c.expectedRevision)
        throw new SuriError("CONFLICT", "Preferences changed.");
      const patch: Data = {};
      for (const key of [
        "sidebarWidth",
        "detailsWidth",
        "fontScale",
        "reducedMotion",
        "selectedSession",
        "detailsOpen",
        "navigationGroup",
        "navigationOrder",
        "navigationUnreadOnly",
        "navigationRecentOnly",
        "scopedModels",
        "pinnedCollapsed",
        "generalCollapsed",
        "projectCollapsed",
        "projectSessionsExpanded",
      ])
        if (key in (p.patch ?? {})) patch[key] = p.patch[key];
      result = store.put("preferences", {
        id: "preferences",
        revision: old.revision + 1,
        values: { ...old.values, ...patch },
      });
      return result;
    },
    draftGet(id: string | undefined, draftOwner: string): Data {
      let result: Data = {};
      if (!id) throw new SuriError("VALIDATION", "Select a session.");
      try {
        result = store.get("draft", `${id}:${draftOwner}`);
        result = {
          ...result,
          attachments: (result.attachmentIds ?? []).map((assetId: string) => {
            const asset = store.get("asset", assetId);
            return { id: asset.id, name: asset.name, mime: asset.mime };
          }),
        };
      } catch {
        result = {
          text: "",
          attachmentIds: [],
          attachments: [],
          revision: 0,
        };
      }
      return result;
    },
    draftSave(
      c: Command,
      p: Data,
      id: string | undefined,
      draftOwner: string,
    ): Data {
      let result: Data = {};
      if (!id) throw new SuriError("VALIDATION", "Select a session.");
      if (
        typeof p.text !== "string" ||
        p.text.length > 1048576 ||
        !Array.isArray(p.attachmentIds) ||
        p.attachmentIds.length > 20
      )
        throw new SuriError("VALIDATION", "Invalid draft.");
      for (const attachmentId of p.attachmentIds) {
        const attachment = store.get("asset", attachmentId);
        if (attachment.sessionId !== id)
          throw new SuriError(
            "PATH_DENIED",
            "Attachment belongs to another session.",
          );
      }
      let revision = 0;
      try {
        revision = store.get("draft", `${id}:${draftOwner}`).revision;
      } catch {
        // No stored draft yet: the revision stays 0 for the conflict check.
      }
      if (c.expectedRevision !== undefined && c.expectedRevision !== revision)
        throw new SuriError("CONFLICT", "The draft changed in another window.");
      result = store.put("draft", {
        id: `${id}:${draftOwner}`,
        sessionId: id,
        clientId: draftOwner,
        text: p.text,
        attachmentIds: p.attachmentIds,
        revision: revision + 1,
        updatedAt: new Date().toISOString(),
      });
      return result;
    },
  };
}
