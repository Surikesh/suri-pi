export type LocalRelease = {
  root: string;
  cli: string;
  assets: string;
  helper: string;
  immutable: boolean;
};
export type ActiveRelease = { release: string; previous?: string };
export type ManifestFile = {
  path: string;
  bytes: number;
  sha256: string;
  executable: boolean;
};
type ManifestDependency = {
  path: string;
  name: string;
  version: string;
  integrity: string;
};
export type ReleaseManifest = {
  schema: 1;
  product: "suri-pi";
  productVersion: string;
  dependencies: ManifestDependency[];
  files: ManifestFile[];
};
export type ReadyMarker = {
  schema: 1;
  manifestSha256: string;
  files: ManifestFile[];
};
