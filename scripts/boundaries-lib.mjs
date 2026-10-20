import { readdir, readFile, stat } from "node:fs/promises";
import { builtinModules } from "node:module";
import {
  dirname,
  extname,
  join,
  normalize,
  relative,
  resolve,
  sep,
} from "node:path";
import ts from "typescript";

const sourceExtensions = [
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
];

// Emitted JavaScript spellings resolve to TypeScript sources first (TypeScript file-extension substitution).
const emittedSubstitutions = {
  ".js": [".ts", ".tsx"],
  ".jsx": [".tsx"],
  ".mjs": [".mts"],
  ".cjs": [".cts"],
};

// Unit key -> sibling packages it may import. Units absent from this table may import none.
export const defaultPackageEdges = {
  "apps/host": ["protocol", "pi-adapter", "model-chain"],
  "apps/web": ["protocol"],
  "packages/protocol": [],
  "packages/pi-adapter": ["protocol", "model-chain"],
  "packages/model-chain": [],
};

// Physical-line caps for product sources; named exceptions are the only allowed widening.
export const defaultSizeLimits = {
  source: 400,
  css: 600,
  exceptions: {
    "apps/host/src/host.ts": 1050,
    "apps/host/src/cli-migrate.ts": 470,
    "packages/pi-adapter/src/pi-client.ts": 470,
    "packages/pi-adapter/src/review-queue-runtime.ts": 550,
    "apps/web/src/dsh-file-icons.tsx": 450,
  },
};

const nodeBuiltins = new Set(builtinModules);

async function isFile(path) {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

export async function collectSources(root, extensions = sourceExtensions) {
  const files = [];
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (["node_modules", "dist", ".release"].includes(entry.name)) continue;
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (extensions.includes(extname(entry.name))) files.push(path);
    }
  }
  await walk(resolve(root));
  return files.sort();
}

export function importedSpecifiers(source, _fileName = "source.ts") {
  const info = ts.preProcessFile(source, true, true);
  return [...info.importedFiles, ...info.referencedFiles].map(
    (item) => item.fileName,
  );
}

// Resolves a relative specifier to a real file (never a directory), or null.
async function resolveLocalImport(fromFile, specifier) {
  if (!specifier.startsWith(".")) return null;
  return resolveBase(
    resolve(dirname(fromFile), specifier.replace(/[?#].*$/, "")),
  );
}

async function resolveBase(base) {
  const emitted = extname(base);
  const stem = base.slice(0, base.length - emitted.length);
  const substitutions = emittedSubstitutions[emitted];
  // An emitted spelling names a file; only extensionless specifiers may fall back to index files.
  const candidates = substitutions
    ? [...substitutions.map((extension) => stem + extension), base]
    : [
        base,
        ...sourceExtensions.map((extension) => base + extension),
        ...sourceExtensions.map((extension) =>
          resolve(base, "index" + extension),
        ),
      ];
  for (const candidate of candidates) {
    if (await isFile(candidate)) return normalize(candidate);
  }
  return null;
}

// Discovers every packages/*/src plus both apps under an explicit project root.
export async function discoverRoots(projectRoot) {
  const roots = [];
  for (const group of ["packages", "apps"]) {
    let entries = [];
    try {
      entries = await readdir(join(projectRoot, group), {
        withFileTypes: true,
      });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const src = join(projectRoot, group, entry.name, "src");
      try {
        if ((await stat(src)).isDirectory()) roots.push(src);
      } catch {
        // No src directory: not a source package.
      }
    }
  }
  return roots.sort();
}

function exportTargets(value) {
  if (typeof value === "string") return [value];
  if (value && typeof value === "object")
    return Object.values(value).flatMap(exportTargets);
  return [];
}

// Loads workspace manifests: packages carry exports maps; apps are only name-addressable.
async function loadPackages(projectRoot, violations) {
  const packages = new Map();
  for (const group of ["packages", "apps"]) {
    let entries = [];
    try {
      entries = await readdir(join(projectRoot, group), {
        withFileTypes: true,
      });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const directory = join(projectRoot, group, entry.name);
      let manifest;
      try {
        manifest = JSON.parse(
          await readFile(join(directory, "package.json"), "utf8"),
        );
      } catch {
        continue;
      }
      const label = `${group}/${entry.name}/package.json`;
      const raw = manifest.exports;
      const hasKeys =
        raw &&
        typeof raw === "object" &&
        Object.keys(raw).some((key) => key.startsWith("."));
      const map =
        raw && typeof raw === "object" && !hasKeys
          ? { ".": raw }
          : typeof raw === "string"
            ? { ".": raw }
            : (raw ?? {});
      const keys = new Map();
      for (const [key, value] of Object.entries(map)) {
        const rawTargets = exportTargets(value);
        if (key.includes("*") || rawTargets.some((t) => t.includes("*"))) {
          violations.push(`${label}: wildcard export ${key}`);
          continue;
        }
        // A key that is itself a src path publishes a private file under its source location.
        if (key === "./src" || key.startsWith("./src/")) {
          violations.push(`${label}: private src alias export ${key}`);
          continue;
        }
        const targets = rawTargets.map((target) =>
          normalize(resolve(directory, target)),
        );
        for (const [index, target] of targets.entries()) {
          if (!(await isFile(target))) {
            violations.push(
              `${label}: export ${key} target ${rawTargets[index]} does not exist`,
            );
          }
        }
        keys.set(key, targets);
      }
      packages.set(manifest.name ?? `${group}/${entry.name}`, {
        group,
        dir: entry.name,
        directory,
        name: manifest.name,
        keys,
        targets: new Set([...keys.values()].flat()),
      });
    }
  }
  return packages;
}

function unitOf(projectPath) {
  const match = /^(packages|apps)\/([^/]+)\/src\//.exec(projectPath);
  return match
    ? { kind: match[1], name: match[2], key: `${match[1]}/${match[2]}` }
    : null;
}

// Target classification is path-wide: a file anywhere under a unit directory belongs to that unit.
function targetUnitOf(projectPath) {
  const match = /^(packages|apps)\/([^/]+)\//.exec(projectPath);
  return match
    ? { kind: match[1], name: match[2], key: `${match[1]}/${match[2]}` }
    : null;
}

function featureOwner(path) {
  const parts = normalize(path).split(sep);
  const index = parts.lastIndexOf("features");
  if (index < 0 || !parts[index + 1]) return null;
  const isModuleFile = index + 2 === parts.length;
  const name = isModuleFile
    ? parts[index + 1].replace(/\.[^.]+$/, "")
    : parts[index + 1];
  return { name, index, parts };
}

function physicalLines(source) {
  if (source === "") return 0;
  const count = source.split("\n").length;
  return source.endsWith("\n") ? count - 1 : count;
}

export async function analyzeBoundaries(roots, options = {}) {
  const projectRoot = resolve(options.projectRoot ?? process.cwd());
  const edges = options.packageEdges ?? defaultPackageEdges;
  const limits = options.sizeLimits ?? defaultSizeLimits;
  const violations = [];
  const scanRoots = roots ?? (await discoverRoots(projectRoot));
  const packages = await loadPackages(projectRoot, violations);
  const everything = (
    await Promise.all(
      scanRoots.map((root) =>
        collectSources(root, [...sourceExtensions, ".css"]),
      ),
    )
  ).flat();
  const files = everything.filter((file) => extname(file) !== ".css");
  const graph = new Map(files.map((file) => [normalize(file), []]));
  const projectRelative = (file) =>
    relative(projectRoot, file).split(sep).join("/");

  for (const file of everything) {
    const projectPath = projectRelative(file);
    if (!unitOf(projectPath)) continue;
    const css = extname(file) === ".css";
    const cap =
      limits.exceptions[projectPath] ?? (css ? limits.css : limits.source);
    const lines = physicalLines(await readFile(file, "utf8"));
    if (lines > cap) {
      violations.push(`${projectPath}: ${lines} lines exceed size cap ${cap}`);
    }
  }

  for (const file of files) {
    const normalizedFile = normalize(file);
    const source = await readFile(file, "utf8");
    const projectPath = projectRelative(file);
    const unit = unitOf(projectPath);
    for (const specifier of importedSpecifiers(source, file)) {
      const isWebOrProtocol =
        projectPath.startsWith("apps/web/src/") ||
        projectPath.startsWith("packages/protocol/src/");
      const bare = specifier.replace(/^node:/, "").split("/")[0];
      if (
        isWebOrProtocol &&
        (/^node:/.test(specifier) ||
          nodeBuiltins.has(bare) ||
          /(^|\/)(pi-coding-agent|pi-web|deepseek)(\/|$)/i.test(specifier) ||
          specifier.includes("pi-adapter"))
      ) {
        violations.push(
          `${projectPath}: prohibited runtime import ${specifier}`,
        );
      }

      const relativeSpecifier = specifier.startsWith(".");
      let targets = [];
      let targetUnit = null;
      let namedPackage = null;
      if (relativeSpecifier) {
        const resolved = await resolveLocalImport(file, specifier);
        if (!resolved) {
          violations.push(`${projectPath}: unresolved import ${specifier}`);
          continue;
        }
        targets = [resolved];
        targetUnit = targetUnitOf(projectRelative(resolved));
      } else {
        // Package-name spellings resolve first; whether the edge crosses units is decided afterwards.
        for (const pkg of packages.values()) {
          if (
            pkg.name &&
            (specifier === pkg.name || specifier.startsWith(pkg.name + "/"))
          ) {
            namedPackage = {
              ...pkg,
              subpath: "." + specifier.slice(pkg.name.length),
            };
          }
        }
        if (namedPackage) {
          targetUnit = {
            kind: namedPackage.group,
            name: namedPackage.dir,
            key: `${namedPackage.group}/${namedPackage.dir}`,
          };
        }
      }
      const cross = Boolean(unit && targetUnit && targetUnit.key !== unit.key);
      if (cross && targetUnit.kind === "apps") {
        violations.push(
          `${projectPath}: forbidden app edge ${unit.key} -> ${targetUnit.key} (${specifier})`,
        );
      } else if (cross && !(edges[unit.key] ?? []).includes(targetUnit.name)) {
        violations.push(
          `${projectPath}: forbidden package edge ${unit.key} -> ${targetUnit.key} (${specifier})`,
        );
      } else if (namedPackage?.group === "packages") {
        const exported = namedPackage.keys.get(namedPackage.subpath);
        if (!exported) {
          violations.push(
            `${projectPath}: unexported package subpath ${specifier}`,
          );
        } else {
          targets = exported;
        }
      } else if (namedPackage) {
        // Apps publish no exports map: a named import resolves to the source path it spells.
        const rest = specifier.slice(namedPackage.name.length + 1);
        const named = rest
          ? await resolveBase(resolve(namedPackage.directory, rest))
          : null;
        if (named) targets = [named];
      } else if (
        cross &&
        relativeSpecifier &&
        targetUnit.kind === "packages" &&
        ![...packages.values()].some(
          (pkg) =>
            pkg.group === "packages" &&
            pkg.dir === targetUnit.name &&
            pkg.targets.has(targets[0]),
        )
      ) {
        violations.push(`${projectPath}: private package import ${specifier}`);
      }

      for (const target of targets) {
        if (graph.has(target)) graph.get(normalizedFile).push(target);
        const owner = featureOwner(normalizedFile);
        const targetOwner = featureOwner(target);
        if (owner && targetOwner && owner.name !== targetOwner.name) {
          const targetParts = target.split(sep);
          const relativeInsideOwner = targetParts
            .slice(targetOwner.index + 2)
            .join("/");
          if (!/^index\.(?:ts|tsx|js|jsx|mjs|cjs)$/.test(relativeInsideOwner)) {
            violations.push(
              `${projectPath}: private feature import ${specifier}`,
            );
          }
        }
        if (owner) {
          const targetParts = target.split(sep);
          if (
            targetParts.slice(0, owner.index).join(sep) ===
              owner.parts.slice(0, owner.index).join(sep) &&
            targetParts[owner.index] === "app"
          ) {
            violations.push(
              `${projectPath}: feature imports app layer ${specifier}`,
            );
          }
        }
      }
    }
  }

  const visiting = new Set();
  const visited = new Set();
  const stack = [];
  function visit(file) {
    if (visiting.has(file)) {
      const start = stack.indexOf(file);
      violations.push(
        `import cycle: ${[...stack.slice(start), file].map((item) => relative(projectRoot, item)).join(" -> ")}`,
      );
      return;
    }
    if (visited.has(file)) return;
    visiting.add(file);
    stack.push(file);
    for (const target of graph.get(file) ?? []) visit(target);
    stack.pop();
    visiting.delete(file);
    visited.add(file);
  }
  for (const file of graph.keys()) visit(file);
  return [...new Set(violations)].sort();
}
