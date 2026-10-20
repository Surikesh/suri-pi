import type {
  UiManifest,
  HostManifest,
  InventoryFile,
} from "../packages/protocol/src/updates.js";
export function digest(bytes: string | Buffer): string;
export class BuildPublicationError extends Error {
  code: string;
  constructor(code: string);
}
export function atomicJson(path: string, value: unknown): Promise<void>;
export function inventory(root: string): Promise<InventoryFile[]>;
export function publishArtifact(
  base: string,
  stage: string,
  identity: UiManifest["identity"] | HostManifest["identity"],
  createdAt?: string,
): Promise<(UiManifest | HostManifest) & { path: string }>;
export const updateCompatibility: UiManifest["identity"]["compatibility"];
export function artifactStage(kind: string, root?: string): string;
