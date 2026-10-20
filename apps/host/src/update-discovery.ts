import { open, lstat } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import { ReadyPointerSchema } from "../../../packages/protocol/src/updates.js";
import {
  ArtifactFailure,
  ImmutableArtifacts,
  type CheckoutIdentity,
} from "./update-artifacts.js";

export type DiscoveredArtifact =
  | { state: "none" }
  | { state: "rejected"; buildId: string | null; code: string }
  | {
      state: "verified";
      buildId: string;
      generation: number;
      compatibility: {
        protocol: 1;
        hostMin: number;
        hostMax: number;
        checkpoint: 1;
        shellMin: number;
      };
      adapterId?: string;
      node?: { version: string; abi: string; platform: string; arch: string };
    };
export class UpdateDiscovery {
  private readonly pending = new Map<
    string,
    Promise<{ ui: DiscoveredArtifact; host: DiscoveredArtifact }>
  >();
  private readonly verified = new Map<
    string,
    Extract<DiscoveredArtifact, { state: "verified" }>
  >();
  constructor(readonly store: ImmutableArtifacts) {}
  reconcile(association: CheckoutIdentity) {
    const key = JSON.stringify(association);
    const previous = this.pending.get(key);
    if (previous) return previous;
    const pending = Promise.all([
      this.discover(association, "ui"),
      this.discover(association, "host"),
    ])
      .then(([ui, host]) => ({ ui, host }))
      .finally(() => {
        this.pending.delete(key);
      });
    this.pending.set(key, pending);
    return pending;
  }
  private async discover(
    association: CheckoutIdentity,
    kind: "ui" | "host",
  ): Promise<DiscoveredArtifact> {
    let buildId: string | null = null;
    try {
      const identity = await lstat(association.path, { bigint: true }).catch(
        () => {
          throw new ArtifactFailure("CHECKOUT_CHANGED");
        },
      );
      if (
        !identity.isDirectory() ||
        String(identity.dev) !== association.device ||
        String(identity.ino) !== association.inode
      )
        throw new ArtifactFailure("CHECKOUT_CHANGED");
      let raw: string;
      try {
        const fd = await open(
          join(association.path, ".build", kind, "latest.json"),
          constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        );
        try {
          const stat = await fd.stat();
          if (!stat.isFile() || stat.size > 4096)
            throw new ArtifactFailure("CANDIDATE_INTEGRITY");
          const buffer = Buffer.alloc(4097);
          const { bytesRead } = await fd.read(buffer, 0, buffer.length, 0);
          if (bytesRead > 4096)
            throw new ArtifactFailure("CANDIDATE_INTEGRITY");
          raw = buffer.subarray(0, bytesRead).toString("utf8");
        } finally {
          await fd.close();
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT")
          return { state: "none" };
        throw error;
      }
      if (Buffer.byteLength(raw) > 4096)
        throw new ArtifactFailure("CANDIDATE_INTEGRITY");
      const pointer = ReadyPointerSchema.parse(JSON.parse(raw));
      buildId = pointer.buildId;
      const key = JSON.stringify([association, kind]);
      const previous = this.verified.get(key);
      if (
        previous &&
        (pointer.generation < previous.generation ||
          (pointer.generation === previous.generation &&
            previous.buildId !== buildId))
      )
        throw new ArtifactFailure("CANDIDATE_INTEGRITY");
      if (
        previous?.generation === pointer.generation &&
        previous.buildId === buildId
      )
        return previous;
      const { manifest } = await this.store.import(association, kind, buildId);
      const verified: Extract<DiscoveredArtifact, { state: "verified" }> = {
        state: "verified",
        buildId,
        generation: pointer.generation,
        compatibility: manifest.identity.compatibility,
        ...("adapterId" in manifest.identity
          ? {
              adapterId: manifest.identity.adapterId,
              node: manifest.identity.node,
            }
          : {}),
      };
      this.verified.set(key, verified);
      return verified;
    } catch (error) {
      return {
        state: "rejected",
        buildId,
        code:
          error instanceof ArtifactFailure ? error.code : "CANDIDATE_INTEGRITY",
      };
    }
  }
}
