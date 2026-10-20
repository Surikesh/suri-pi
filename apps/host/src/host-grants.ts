import { SuriError } from "../../../packages/protocol/src/index.js";
import type { RuntimeValidationProfile } from "./runtime-validation.js";

type Grant =
  | { path: string; kind: string; expires: number }
  | {
      profile: RuntimeValidationProfile;
      kind: "runtime-validation";
      expires: number;
    };

/** Sole owner of the host's consumable path and runtime-validation grants. */
export function createGrants() {
  const grants = new Map<string, Grant>();
  return {
    mint(id: string, entry: Grant) {
      grants.set(id, entry);
    },
    discard(id: string) {
      grants.delete(id);
    },
    grant(id: string, kind: string) {
      const g = grants.get(id);
      if (!g || g.expires < Date.now() || g.kind !== kind || !("path" in g))
        throw new SuriError(
          "PATH_DENIED",
          "Select this resource through the local picker or CLI.",
        );
      grants.delete(id);
      return g.path;
    },
    inspectGrant(id: string, kind: string) {
      const g = grants.get(id);
      if (!g || g.expires < Date.now() || g.kind !== kind || !("path" in g))
        throw new SuriError(
          "PATH_DENIED",
          "Select this resource through the local picker or CLI.",
        );
      return g.path;
    },
    validationGrant(id: string) {
      const g = grants.get(id);
      if (
        !g ||
        g.expires < Date.now() ||
        g.kind !== "runtime-validation" ||
        !("profile" in g)
      )
        throw new SuriError(
          "RUNTIME_VALIDATION_UNAUTHORIZED",
          "Real Pi validation requires an explicit local CLI authorization.",
        );
      grants.delete(id);
      return g.profile;
    },
  };
}
export type Grants = ReturnType<typeof createGrants>;
