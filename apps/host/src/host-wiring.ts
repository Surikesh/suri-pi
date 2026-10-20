import { createSessionCommands } from "./host-commands-session.js";
import { createRunCommands } from "./host-commands-run.js";
import { createPiCommands } from "./host-commands-pi.js";
import { createFileCommands } from "./host-commands-files.js";
import { createAssetCommands } from "./host-commands-assets.js";
import { createImportCommands } from "./host-commands-import.js";

type CommandLeafCaps = Parameters<typeof createSessionCommands>[0] &
  Parameters<typeof createRunCommands>[0] &
  Parameters<typeof createPiCommands>[0] &
  Parameters<typeof createFileCommands>[0] &
  Parameters<typeof createAssetCommands>[0] &
  Parameters<typeof createImportCommands>[0];

/**
 * Synchronous, inert construction of the session, run, Pi, file, asset and
 * import command leaves in a fixed order. It registers nothing and
 * reads no mutable host state; every cap is a stable owner reference or a
 * lazy getter supplied by the host.
 */
export function createCommandLeaves(caps: CommandLeafCaps) {
  const sessionCmds = createSessionCommands(caps);
  const runCmds = createRunCommands(caps);
  const piCmds = createPiCommands(caps);
  const fileCmds = createFileCommands(caps);
  const assetCmds = createAssetCommands(caps);
  const importCmds = createImportCommands(caps);
  return { sessionCmds, runCmds, piCmds, fileCmds, assetCmds, importCmds };
}
