// Export inventory guard. Reports every export of apps/ and packages/ whose
// canonical symbol has no real consumer outside its defining file and outside
// the exporting file. Imports, `export { x }`, `export { x } from`,
// `export * from` and `export default <identifier>` only forward a symbol and
// never count as use. Tests do not count as product use. Each retained export
// must be listed in `allowed` with a reason; stale entries also fail.
import { readdirSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = (...parts) => resolve(projectRoot, ...parts);
const rel = (file) =>
  relative(projectRoot, resolve(file)).split("\\").join("/");

/** @type {{file: string, symbol: string, reason: string}[]} */
export const allowed = [
  {
    file: "apps/host/src/cli.ts",
    symbol: "runCli",
    reason: "runtime root: CLI entry",
  },
  {
    file: "apps/web/src/terminal.tsx",
    symbol: "default",
    reason: "runtime root: lazy-loaded chunk",
  },
  {
    file: "apps/web/src/rich.tsx",
    symbol: "default",
    reason: "runtime root: lazy-loaded chunk",
  },
  {
    file: "packages/pi-adapter/src/review-queue-extension.ts",
    symbol: "default",
    reason: "runtime root: Pi extension entry",
  },
  {
    file: "packages/model-chain/src/index.ts",
    symbol: "ChainState",
    reason: "public package surface",
  },
  {
    file: "packages/pi-adapter/src/index.ts",
    symbol: "ReviewQueueCapabilities",
    reason: "public package surface: result type of reviewQueueCapabilities()",
  },
  {
    file: "packages/pi-adapter/src/index.ts",
    symbol: "ReviewQueueCapability",
    reason: "public package surface: result type of reviewQueueCapabilities()",
  },
  {
    file: "packages/pi-adapter/src/review-queue-capabilities.ts",
    symbol: "ReviewQueueCapabilities",
    reason: "public package surface: result type of reviewQueueCapabilities()",
  },
  {
    file: "packages/pi-adapter/src/review-queue-capabilities.ts",
    symbol: "ReviewQueueCapability",
    reason: "public package surface: result type of reviewQueueCapabilities()",
  },
  {
    file: "packages/protocol/src/index.ts",
    symbol: "VERSION",
    reason: "public package surface",
  },
  {
    file: "packages/protocol/src/updates.ts",
    symbol: "InventoryFileSchema",
    reason: "public package surface",
  },
  {
    file: "packages/protocol/src/updates.ts",
    symbol: "UPDATE_SCHEMA",
    reason: "public package surface",
  },
  {
    file: "packages/protocol/src/updates.ts",
    symbol: "UPDATE_UI_CONTRACT",
    reason: "public package surface",
  },
  {
    file: "packages/protocol/src/updates.ts",
    symbol: "UPDATE_SHELL_CONTRACT",
    reason: "public package surface",
  },
  {
    file: "apps/host/src/codex-usage.ts",
    symbol: "parseCodexWeeklyUsage",
    reason: "test seam: codex-usage test",
  },
  {
    file: "apps/host/src/host.ts",
    symbol: "startHost",
    reason: "test seam: startup-boundaries test",
  },
  {
    file: "apps/host/src/legacy-migration.ts",
    symbol: "LegacyMigrationApproval",
    reason: "test seam: update-legacy-migration test",
  },
  {
    file: "apps/host/src/local-release.ts",
    symbol: "rollbackLocalRelease",
    reason: "test seam: local-release test",
  },
  {
    file: "apps/host/src/migrations.ts",
    symbol: "migrate",
    reason: "test seam: migrations integration test",
  },
  {
    file: "apps/host/src/runtime-evidence.ts",
    symbol: "runtimeAcceptanceCases",
    reason: "test seam: runtime-identity test",
  },
  {
    file: "apps/host/src/ui-builds.ts",
    symbol: "validateBuild",
    reason: "test seam: self-edit test",
  },
  {
    file: "apps/host/src/update-status.ts",
    symbol: "UpdateStatusSchema",
    reason: "test seam: update-status-schema test",
  },
  {
    file: "apps/web/src/components/subagent-status.tsx",
    symbol: "parseSubagentStatus",
    reason: "test seam: subagent-status test",
  },
  {
    file: "apps/web/src/rich.tsx",
    symbol: "localFileLabel",
    reason: "test seam: rich-links test",
  },
  {
    file: "apps/web/src/rich.tsx",
    symbol: "localPath",
    reason: "test seam: rich-links test",
  },
  {
    file: "packages/model-chain/src/adapters.ts",
    symbol: "SuriAdapter",
    reason: "test seam: model-chain test",
  },
  {
    file: "packages/model-chain/src/broker-framing.ts",
    symbol: "MAX_BROKER_FRAME_BYTES",
    reason: "test seam: model-chain-broker-framing test",
  },
  {
    file: "apps/host/src/runtime-validation.ts",
    symbol: "assertSessionProfile",
    reason: "test seam: runtime-profile test",
  },
  {
    file: "packages/pi-adapter/src/index.ts",
    symbol: "estimateCompactionHistoryTokens",
    reason: "test seam: adapter test",
  },
  {
    file: "packages/pi-adapter/src/index.ts",
    symbol: "requireReviewQueueCapabilities",
    reason: "test seam: adapter test",
  },
  {
    file: "packages/pi-adapter/src/index.ts",
    symbol: "reviewQueueCapabilities",
    reason: "test seam: adapter test",
  },
  {
    file: "packages/pi-adapter/src/review-queue-runtime.ts",
    symbol: "candidateDigest",
    reason: "test seam: review-queue-runtime test",
  },
  {
    file: "packages/pi-adapter/src/runtime-version.ts",
    symbol: "versionFailure",
    reason: "test seam: runtime-version test",
  },
  {
    file: "packages/protocol/src/updates.ts",
    symbol: "InventorySchema",
    reason: "test seam: update-manifests test",
  },
  {
    file: "packages/protocol/src/updates.ts",
    symbol: "UpdatePathSchema",
    reason: "test seam: update-manifests test",
  },
  {
    file: "apps/host/src/cli-ensure.ts",
    symbol: "resolveLaunchFailure",
    reason: "test seam: cli-identity test (source of cli.ts forward)",
  },
  {
    file: "apps/host/src/cli.ts",
    symbol: "resolveLaunchFailure",
    reason: "test seam: cli-identity test",
  },
  {
    file: "apps/web/src/features/terminal/terminal-pane.tsx",
    symbol: "default",
    reason: "runtime root: lazy-loaded chunk (source of terminal.tsx forward)",
  },
  {
    file: "packages/model-chain/src/suri-adapter.ts",
    symbol: "SuriAdapter",
    reason: "test seam: model-chain test (source of adapters.ts forward)",
  },
  {
    file: "packages/pi-adapter/src/compaction.ts",
    symbol: "estimateCompactionHistoryTokens",
    reason: "test seam: adapter test (source of index.ts forward)",
  },
  {
    file: "packages/pi-adapter/src/review-queue-candidate.ts",
    symbol: "candidateDigest",
    reason: "test seam: review-queue-runtime test (source of runtime forward)",
  },
  {
    file: "packages/pi-adapter/src/review-queue-capabilities.ts",
    symbol: "requireReviewQueueCapabilities",
    reason: "test seam: adapter test (source of index.ts forward)",
  },
  {
    file: "packages/pi-adapter/src/review-queue-capabilities.ts",
    symbol: "reviewQueueCapabilities",
    reason: "test seam: adapter test (source of index.ts forward)",
  },
];

function findings() {
  const config = ts.readConfigFile(root("tsconfig.json"), ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(
    config.config,
    ts.sys,
    projectRoot,
  );
  const scriptFiles = readdirSync(root("scripts"))
    .filter((name) => /\.(ts|mjs)$/.test(name) && !/\.d\.mts$/.test(name))
    .sort()
    .map((name) => root("scripts", name));
  const program = ts.createProgram([...parsed.fileNames, ...scriptFiles], {
    ...parsed.options,
    allowJs: true,
    checkJs: false,
  });
  const checker = program.getTypeChecker();
  const local = program
    .getSourceFiles()
    .filter((file) =>
      /^(apps|packages|scripts|tests)\//.test(rel(file.fileName)),
    );
  const canonical = (symbol) =>
    symbol && symbol.flags & ts.SymbolFlags.Alias
      ? checker.getAliasedSymbol(symbol)
      : symbol;
  const references = new Map();
  for (const file of local) {
    const walk = (node) => {
      // Forwarding syntax is not consumption.
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return;
      if (ts.isExportAssignment(node) && ts.isIdentifier(node.expression))
        return;
      if (
        ts.isIdentifier(node) &&
        (ts.isShorthandPropertyAssignment(node.parent) ||
          !(node.parent.name === node && ts.isDeclaration(node.parent)))
      ) {
        // `{ x }` names the property; the value symbol is the real reference.
        const symbol = canonical(
          ts.isShorthandPropertyAssignment(node.parent)
            ? checker.getShorthandAssignmentValueSymbol(node.parent)
            : checker.getSymbolAtLocation(node),
        );
        if (symbol) {
          if (!references.has(symbol)) references.set(symbol, new Set());
          references.get(symbol).add(rel(file.fileName));
        }
      }
      ts.forEachChild(node, walk);
    };
    walk(file);
  }
  const rows = [];
  for (const file of local.filter((f) =>
    /^(apps|packages)\//.test(rel(f.fileName)),
  )) {
    const moduleSymbol = checker.getSymbolAtLocation(file);
    if (!moduleSymbol) continue;
    for (const exported of checker.getExportsOfModule(moduleSymbol)) {
      const symbol = canonical(exported);
      const declaration =
        exported.declarations?.[0] ?? symbol?.declarations?.[0];
      if (!declaration) continue;
      const defining = new Set(
        (symbol.declarations ?? []).map((d) => rel(d.getSourceFile().fileName)),
      );
      const users = [...(references.get(symbol) ?? [])].filter(
        (user) => user !== rel(file.fileName) && !defining.has(user),
      );
      if (users.some((user) => !user.startsWith("tests/"))) continue;
      rows.push({
        file: rel(file.fileName),
        symbol: exported.name,
        kind: users.length ? "test-only" : "unreferenced",
        line:
          file.getLineAndCharacterOfPosition(declaration.getStart(file)).line +
          1,
      });
    }
  }
  return rows.sort((a, b) =>
    `${a.file} ${a.symbol}`.localeCompare(`${b.file} ${b.symbol}`),
  );
}

const key = (file, symbol) => `${file}\u0000${symbol}`;
export function check(rows, entries) {
  const problems = [];
  const listed = new Map(entries.map((e) => [key(e.file, e.symbol), e]));
  const seen = new Set();
  for (const row of rows) {
    const k = key(row.file, row.symbol);
    seen.add(k);
    if (!listed.has(k))
      problems.push(
        `unexplained export: ${row.file}:${row.line} ${row.symbol} [${row.kind}]`,
      );
  }
  for (const entry of entries)
    if (!seen.has(key(entry.file, entry.symbol)))
      problems.push(
        `stale allowlist entry: ${entry.file} ${entry.symbol} (${entry.reason})`,
      );
  return problems;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const rows = findings();
  if (process.argv.includes("--print")) {
    for (const r of rows)
      console.log(`${r.file}:${r.line} ${r.symbol} [${r.kind}]`);
    console.log(rows.length);
    process.exit(0);
  }
  const problems = check(rows, allowed);
  if (problems.length > 0) {
    console.error(problems.join("\n"));
    process.exit(1);
  }
  console.log(`Suri export inventory: OK (${rows.length} explained)`);
}
