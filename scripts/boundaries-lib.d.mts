export interface BoundaryOptions {
  projectRoot?: string;
  packageEdges?: Record<string, string[]>;
  sizeLimits?: {
    source: number;
    css: number;
    exceptions: Record<string, number>;
  };
}
export const defaultPackageEdges: Record<string, string[]>;
export const defaultSizeLimits: BoundaryOptions["sizeLimits"];
export function collectSources(
  root: string,
  extensions?: string[],
): Promise<string[]>;
export function discoverRoots(projectRoot: string): Promise<string[]>;
export function importedSpecifiers(source: string, fileName?: string): string[];
export function analyzeBoundaries(
  roots: string[] | null,
  options?: BoundaryOptions,
): Promise<string[]>;
