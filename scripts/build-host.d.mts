import type { HostManifest } from "../packages/protocol/src/updates.js";
export function dependencyClosure(
  lock: {
    packages: Record<
      string,
      {
        version?: string;
        integrity?: string;
        link?: boolean;
        dependencies?: Record<string, string>;
        optionalDependencies?: Record<string, string>;
      }
    >;
  },
  roots?: string[],
): Array<{
  path: string;
  name: string;
  version: string;
  integrity: string;
  optional: boolean;
}>;
export function buildHost(options?: {
  root?: string;
}): Promise<HostManifest & { path: string }>;
