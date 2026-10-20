import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
// The production checker is plain ESM so it can run before TypeScript builds.
import {
  analyzeBoundaries,
  discoverRoots,
} from "../../scripts/boundaries-lib.mjs";

const temporaryRoots: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

const manifest = (name: string, exports: Record<string, string>) =>
  JSON.stringify({ name, type: "module", exports });

// A clean baseline project; every case adds or replaces files and must change only its own verdict.
const baseline: Record<string, string> = {
  "packages/protocol/package.json": manifest("@suri/protocol", {
    ".": "./src/index.ts",
    "./updates": "./src/updates.ts",
  }),
  "packages/protocol/src/index.ts": "export const protocol = 1;",
  "packages/protocol/src/updates.ts": "export const updates = 1;",
  "packages/pi-adapter/package.json": manifest("@suri/pi-adapter", {
    ".": "./src/index.ts",
    "./review-queue": "./src/review-queue.ts",
    "./review-queue-extension": "./src/review-queue-extension.ts",
  }),
  "packages/pi-adapter/src/index.ts": "export const adapter = 1;",
  "packages/pi-adapter/src/review-queue.ts": "export const queue = 1;",
  "packages/pi-adapter/src/review-queue-extension.ts": "export const ext = 1;",
  "packages/pi-adapter/src/review-queue-runtime.ts": "export const rt = 1;",
  "packages/model-chain/package.json": manifest("@suri-pi/model-chain", {
    ".": "./src/index.ts",
    "./adapters": "./src/adapters.ts",
    "./broker": "./src/broker.ts",
  }),
  "packages/model-chain/src/index.ts": "export const chain = 1;",
  "packages/model-chain/src/adapters.ts": "export const adapters = 1;",
  "packages/model-chain/src/broker.ts": "export const broker = 1;",
  "packages/model-chain/src/broker-framing.ts": "export const framing = 1;",
  "apps/host/src/host.ts": "export const host = 1;",
  "apps/web/src/main.ts": "export const web = 1;",
  "apps/web/src/app/state.ts": "export const state = 1;",
  "apps/web/src/features/a/index.ts": "export const a = 1;",
  "apps/web/src/features/b/index.ts": "export const b = 1;",
  "apps/web/src/features/b/private.ts": "export const hidden = 1;",
};

async function project(overrides: Record<string, string> = {}) {
  const root = await mkdtemp(join(tmpdir(), "suri-boundaries-neg-"));
  temporaryRoots.push(root);
  for (const [path, content] of Object.entries({ ...baseline, ...overrides })) {
    const target = join(root, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
  }
  return root;
}

// Default discovery from an explicit project root: no process.cwd dependence.
async function check(overrides: Record<string, string> = {}) {
  const projectRoot = await project(overrides);
  return analyzeBoundaries(null, { projectRoot });
}

const lines = (count: number) => "// x\n".repeat(count);

describe("boundary baseline", () => {
  test("the clean fixture project has no violations", async () => {
    expect(await check()).toEqual([]);
  });

  test("the real repository graph has no violations", async () => {
    const projectRoot = resolve(
      dirname(fileURLToPath(import.meta.url)),
      "../..",
    );
    expect(await analyzeBoundaries(null, { projectRoot })).toEqual([]);
  });
});

const forbiddenCases: Array<[string, string, string, string]> = [
  [
    "protocol -> pi-adapter",
    "packages/protocol/src/index.ts",
    'import "../../pi-adapter/src/index.js";',
    "forbidden package edge packages/protocol -> packages/pi-adapter",
  ],
  [
    "protocol -> model-chain",
    "packages/protocol/src/index.ts",
    'import "../../model-chain/src/index.js";',
    "forbidden package edge packages/protocol -> packages/model-chain",
  ],
  [
    "model-chain -> protocol",
    "packages/model-chain/src/index.ts",
    'import "../../protocol/src/index.js";',
    "forbidden package edge packages/model-chain -> packages/protocol",
  ],
  [
    "model-chain -> pi-adapter",
    "packages/model-chain/src/index.ts",
    'import "../../pi-adapter/src/index.js";',
    "forbidden package edge packages/model-chain -> packages/pi-adapter",
  ],
  [
    "model-chain -> protocol by package name",
    "packages/model-chain/src/index.ts",
    'import "@suri/protocol";',
    "forbidden package edge packages/model-chain -> packages/protocol",
  ],
  [
    "pi-adapter -> host",
    "packages/pi-adapter/src/index.ts",
    'import "../../../apps/host/src/host.js";',
    "forbidden app edge packages/pi-adapter -> apps/host",
  ],
  [
    "protocol -> web",
    "packages/protocol/src/index.ts",
    'import "../../../apps/web/src/main.js";',
    "forbidden app edge packages/protocol -> apps/web",
  ],
  [
    "model-chain -> web",
    "packages/model-chain/src/index.ts",
    'import "../../../apps/web/src/main.js";',
    "forbidden app edge packages/model-chain -> apps/web",
  ],
  [
    "web -> host",
    "apps/web/src/main.ts",
    'import "../../host/src/host.js";',
    "forbidden app edge apps/web -> apps/host",
  ],
  [
    "host -> web",
    "apps/host/src/host.ts",
    'import "../../web/src/main.js";',
    "forbidden app edge apps/host -> apps/web",
  ],
  [
    "web -> pi-adapter",
    "apps/web/src/main.ts",
    'import "../../../packages/pi-adapter/src/index.js";',
    "forbidden package edge apps/web -> packages/pi-adapter",
  ],
  [
    "web -> model-chain",
    "apps/web/src/main.ts",
    'import "../../../packages/model-chain/src/index.js";',
    "forbidden package edge apps/web -> packages/model-chain",
  ],
];

const bypassCases: Array<[string, string, string, string]> = [
  [
    "host -> private review-queue-runtime",
    "apps/host/src/host.ts",
    'import "../../../packages/pi-adapter/src/review-queue-runtime.js";',
    "private package import ../../../packages/pi-adapter/src/review-queue-runtime.js",
  ],
  [
    "host -> private broker-framing",
    "apps/host/src/host.ts",
    'import "../../../packages/model-chain/src/broker-framing.js";',
    "private package import ../../../packages/model-chain/src/broker-framing.js",
  ],
  [
    "pi-adapter -> private model-chain file",
    "packages/pi-adapter/src/index.ts",
    'import "../../model-chain/src/broker-framing.js";',
    "private package import ../../model-chain/src/broker-framing.js",
  ],
  [
    "package-name unexported subpath",
    "apps/host/src/host.ts",
    'import "@suri/protocol/private";',
    "unexported package subpath @suri/protocol/private",
  ],
  [
    "feature -> private feature file",
    "apps/web/src/features/a/index.ts",
    'import "../b/private.js";',
    "private feature import ../b/private.js",
  ],
  [
    "feature implementation -> app layer",
    "apps/web/src/features/a/index.ts",
    'import "../../app/state.js";',
    "feature imports app layer ../../app/state.js",
  ],
  [
    "web -> node: builtin",
    "apps/web/src/main.ts",
    'import "node:fs";',
    "prohibited runtime import node:fs",
  ],
  [
    "web -> unprefixed node builtin",
    "apps/web/src/main.ts",
    'import "path";',
    "prohibited runtime import path",
  ],
  [
    "web -> Pi runtime",
    "apps/web/src/main.ts",
    'import "@earendil/pi-coding-agent";',
    "prohibited runtime import @earendil/pi-coding-agent",
  ],
  [
    "protocol -> node: builtin",
    "packages/protocol/src/index.ts",
    'import "node:path";',
    "prohibited runtime import node:path",
  ],
  [
    "missing relative target",
    "apps/web/src/main.ts",
    'import "./missing.js";',
    "unresolved import ./missing.js",
  ],
];

describe("forbidden package and app edges", () => {
  test.each(forbiddenCases)("%s", async (_name, file, content, diagnostic) => {
    const violations = await check({ [file]: content });
    expect(violations.some((value) => value.includes(diagnostic))).toBe(true);
  });
});

describe("public surface and structural bypasses", () => {
  test.each(bypassCases)("%s", async (_name, file, content, diagnostic) => {
    const violations = await check({ [file]: content });
    expect(violations.some((value) => value.includes(diagnostic))).toBe(true);
  });

  test("wildcard exports are rejected", async () => {
    const violations = await check({
      "packages/protocol/package.json": manifest("@suri/protocol", {
        ".": "./src/index.ts",
        "./*": "./src/*.ts",
      }),
    });
    expect(violations).toContain(
      "packages/protocol/package.json: wildcard export ./*",
    );
  });

  test("a package without an exports map exposes nothing", async () => {
    const violations = await check({
      "packages/protocol/package.json": JSON.stringify({
        name: "@suri/protocol",
      }),
      "apps/host/src/host.ts":
        'import "../../../packages/protocol/src/index.js";',
    });
    expect(violations.some((value) => value.includes("private package"))).toBe(
      true,
    );
  });
});

const allowedCases: Array<[string, string, string]> = [
  [
    "pi-adapter -> protocol",
    "packages/pi-adapter/src/index.ts",
    'import "../../protocol/src/index.js";',
  ],
  [
    "pi-adapter -> model-chain adapters (relative)",
    "packages/pi-adapter/src/review-queue-extension.ts",
    'import "../../model-chain/src/adapters.js";',
  ],
  [
    "pi-adapter -> model-chain root and adapters (package name)",
    "packages/pi-adapter/src/index.ts",
    'import "@suri-pi/model-chain"; import "@suri-pi/model-chain/adapters";',
  ],
  [
    "host public subpaths (relative)",
    "apps/host/src/host.ts",
    [
      'import "../../../packages/protocol/src/updates.js";',
      'import "../../../packages/pi-adapter/src/review-queue.js";',
      'import "../../../packages/model-chain/src/broker.js";',
    ].join("\n"),
  ],
  [
    "host public subpaths (package name) and executable root",
    "apps/host/src/host.ts",
    [
      'import "@suri/protocol/updates";',
      'import "@suri/pi-adapter/review-queue";',
      'import "@suri/pi-adapter/review-queue-extension";',
      'import "@suri-pi/model-chain/broker";',
    ].join("\n"),
  ],
  [
    "host -> executable root file",
    "apps/host/src/host.ts",
    'import "../../../packages/pi-adapter/src/review-queue-extension.js";',
  ],
  [
    "web protocol type import",
    "apps/web/src/main.ts",
    'import type { protocol } from "../../../packages/protocol/src/index.js";',
  ],
  [
    "public feature index",
    "apps/web/src/features/a/index.ts",
    'import "../b/index.js";',
  ],
  [
    "app layer -> feature",
    "apps/web/src/app/state.ts",
    'import "../features/a/index.js";',
  ],
];

describe("paired positives", () => {
  test.each(allowedCases)("%s", async (_name, file, content) => {
    expect(await check({ [file]: content })).toEqual([]);
  });
});

describe("resolver", () => {
  test("a .js-spelled A <-> B cycle is found", async () => {
    const violations = await check({
      "apps/web/src/a.ts": 'import "./b.js";',
      "apps/web/src/b.ts": 'import "./a.js";',
    });
    expect(violations.some((value) => value.includes("import cycle"))).toBe(
      true,
    );
  });

  test("emitted .mjs and .tsx spellings resolve to sources", async () => {
    const violations = await check({
      "apps/web/src/a.ts": 'import "./b.mjs"; import "./c.js";',
      "apps/web/src/b.mts": 'import "./a.js";',
      "apps/web/src/c.tsx": "export const c = 1;",
    });
    expect(violations.some((value) => value.includes("import cycle"))).toBe(
      true,
    );
    expect(violations.some((value) => value.includes("unresolved"))).toBe(
      false,
    );
  });

  test("directory imports resolve through index files", async () => {
    const violations = await check({
      "apps/web/src/a.ts": 'import "./dir";',
      "apps/web/src/dir/index.ts": 'import "../a.js";',
    });
    expect(violations.some((value) => value.includes("import cycle"))).toBe(
      true,
    );
  });

  test("a directory is never accepted as the target of a .js specifier", async () => {
    const violations = await check({
      "apps/web/src/a.ts": 'import "./dir.js";',
      "apps/web/src/dir/index.ts": "export const x = 1;",
    });
    expect(violations).toEqual([
      "apps/web/src/a.ts: unresolved import ./dir.js",
    ]);
  });
});

describe("default discovery", () => {
  test("includes every package src plus both apps, including an extra package", async () => {
    const projectRoot = await project({
      "packages/extra/package.json": manifest("@suri/extra", {
        ".": "./src/index.ts",
      }),
      "packages/extra/src/index.ts": 'import "../../protocol/src/index.js";',
    });
    const roots = (await discoverRoots(projectRoot)).map((root: string) =>
      root.slice(projectRoot.length + 1),
    );
    expect(roots).toEqual(
      expect.arrayContaining([
        "packages/protocol/src",
        "packages/pi-adapter/src",
        "packages/model-chain/src",
        "packages/extra/src",
        "apps/host/src",
        "apps/web/src",
      ]),
    );
    const violations = await analyzeBoundaries(null, { projectRoot });
    expect(violations).toEqual([
      "packages/extra/src/index.ts: forbidden package edge packages/extra -> packages/protocol (../../protocol/src/index.js)",
    ]);
  });
});

describe("size caps", () => {
  test("a source file over 400 physical lines is rejected, exactly 400 passes", async () => {
    expect(await check({ "apps/web/src/big.ts": lines(400) })).toEqual([]);
    expect(await check({ "apps/web/src/big.ts": lines(401) })).toEqual([
      "apps/web/src/big.ts: 401 lines exceed size cap 400",
    ]);
  });

  test("blank lines and comments count as physical lines", async () => {
    expect(await check({ "apps/web/src/big.ts": "\n".repeat(401) })).toEqual([
      "apps/web/src/big.ts: 401 lines exceed size cap 400",
    ]);
  });

  test("CSS is capped at 600", async () => {
    expect(await check({ "apps/web/src/a.css": lines(600) })).toEqual([]);
    expect(await check({ "apps/web/src/a.css": lines(601) })).toEqual([
      "apps/web/src/a.css: 601 lines exceed size cap 600",
    ]);
  });

  test("named exceptions accept their exact cap and reject cap + 1", async () => {
    const named: Array<[string, number]> = [
      ["apps/host/src/host.ts", 1050],
      ["apps/host/src/cli-migrate.ts", 470],
      ["packages/pi-adapter/src/pi-client.ts", 470],
      ["packages/pi-adapter/src/review-queue-runtime.ts", 550],
      ["apps/web/src/dsh-file-icons.tsx", 450],
    ];
    for (const [path, cap] of named) {
      expect(await check({ [path]: lines(cap) })).toEqual([]);
      expect(await check({ [path]: lines(cap + 1) })).toEqual([
        `${path}: ${cap + 1} lines exceed size cap ${cap}`,
      ]);
    }
  });

  test("an exception does not follow the file name to another directory", async () => {
    expect(await check({ "apps/web/src/host.ts": lines(450) })).toEqual([
      "apps/web/src/host.ts: 450 lines exceed size cap 400",
    ]);
  });
});

const appManifests = {
  "apps/host/package.json": JSON.stringify({ name: "@suri/host" }),
  "apps/web/package.json": JSON.stringify({ name: "@suri/web" }),
};

describe("package-name resolution (R2)", () => {
  const selfImport = 'import "@suri-pi/model-chain/broker";';
  const backImport = 'import "./index.js";';

  test("a package-name self-import cycle is rejected", async () => {
    const violations = await check({
      "packages/model-chain/src/index.ts": selfImport,
      "packages/model-chain/src/broker.ts": backImport,
    });
    expect(violations.some((value) => value.startsWith("import cycle:"))).toBe(
      true,
    );
  });

  test("the same self-import without a back edge passes", async () => {
    expect(
      await check({ "packages/model-chain/src/index.ts": selfImport }),
    ).toEqual([]);
  });

  test("an unexported self-import subpath is rejected", async () => {
    const violations = await check({
      "packages/model-chain/src/index.ts":
        'import "@suri-pi/model-chain/broker-framing";',
    });
    expect(violations).toEqual([
      "packages/model-chain/src/index.ts: unexported package subpath @suri-pi/model-chain/broker-framing",
    ]);
  });

  test("an exported target that does not exist is rejected", async () => {
    const violations = await check({
      "packages/protocol/package.json": manifest("@suri/protocol", {
        ".": "./src/index.ts",
        "./updates": "./src/gone.ts",
      }),
    });
    expect(violations).toEqual([
      "packages/protocol/package.json: export ./updates target ./src/gone.ts does not exist",
    ]);
  });

  test("a condition-only exports object is the root export", async () => {
    const files = {
      "packages/protocol/package.json": JSON.stringify({
        name: "@suri/protocol",
        exports: { import: "./src/index.ts" },
      }),
      "apps/host/src/host.ts": 'import "@suri/protocol";',
    };
    expect(await check(files)).toEqual([]);
  });
});

describe("workspace-name app edges (R2)", () => {
  const cases: Array<[string, string, string, string]> = [
    [
      "web -> host",
      "apps/web/src/main.ts",
      'import "@suri/host/src/host.js";',
      "forbidden app edge apps/web -> apps/host",
    ],
    [
      "host -> web",
      "apps/host/src/host.ts",
      'import "@suri/web/src/main.js";',
      "forbidden app edge apps/host -> apps/web",
    ],
    [
      "model-chain -> host",
      "packages/model-chain/src/index.ts",
      'import "@suri/host/src/host.js";',
      "forbidden app edge packages/model-chain -> apps/host",
    ],
    [
      "model-chain -> web",
      "packages/model-chain/src/index.ts",
      'import "@suri/web/src/main.js";',
      "forbidden app edge packages/model-chain -> apps/web",
    ],
    [
      "protocol -> bare app name",
      "packages/protocol/src/index.ts",
      'import "@suri/host";',
      "forbidden app edge packages/protocol -> apps/host",
    ],
  ];

  test.each(cases)("%s", async (_name, file, content, diagnostic) => {
    const violations = await check({ ...appManifests, [file]: content });
    expect(violations.some((value) => value.includes(diagnostic))).toBe(true);
  });

  test("an app importing its own name and a relative sibling passes", async () => {
    expect(
      await check({
        ...appManifests,
        "apps/web/src/main.ts": 'import "@suri/web/src/app/state.js";',
      }),
    ).toEqual([]);
  });

  test("a package-name self-import cycle inside an app is rejected", async () => {
    const violations = await check({
      ...appManifests,
      "apps/web/src/main.ts": 'import "@suri/web/src/app/state.js";',
      "apps/web/src/app/state.ts": 'import "../main.js";',
    });
    expect(violations.some((value) => value.startsWith("import cycle:"))).toBe(
      true,
    );
  });

  test("a feature importing another feature's private file by app name is rejected", async () => {
    const violations = await check({
      ...appManifests,
      "apps/web/src/features/a/index.ts":
        'import "@suri/web/src/features/b/private.js";',
    });
    expect(
      violations.some((value) => value.includes("private feature import")),
    ).toBe(true);
  });
});

describe("private src export aliases (R2)", () => {
  test.each(["./src/private", "./src"])("key %s is rejected", async (key) => {
    const violations = await check({
      "packages/protocol/package.json": manifest("@suri/protocol", {
        ".": "./src/index.ts",
        [key]: "./src/updates.ts",
      }),
      "apps/host/src/host.ts": `import "@suri/protocol${key.slice(1)}";`,
    });
    expect(violations).toContain(
      `packages/protocol/package.json: private src alias export ${key}`,
    );
    expect(
      violations.some((value) => value.includes("unexported package subpath")),
    ).toBe(true);
  });

  test("public keys whose targets live under src pass", async () => {
    expect(
      await check({
        "packages/protocol/package.json": manifest("@suri/protocol", {
          ".": "./src/index.ts",
          "./updates": "./src/updates.ts",
          "./srcish": "./src/updates.ts",
        }),
      }),
    ).toEqual([]);
  });
});

describe("other dropped-import classes (R2)", () => {
  test("a feature importing another feature's private non-source file is rejected", async () => {
    const violations = await check({
      "apps/web/src/features/b/private.css": "a{}",
      "apps/web/src/features/a/index.ts": 'import "../b/private.css";',
    });
    expect(violations).toEqual([
      "apps/web/src/features/a/index.ts: private feature import ../b/private.css",
    ]);
  });

  test("a feature importing its own css passes", async () => {
    expect(
      await check({
        "apps/web/src/features/a/a.css": "a{}",
        "apps/web/src/features/a/index.ts": 'import "./a.css";',
      }),
    ).toEqual([]);
  });

  test("a cross-package import of a non-src file is a private import", async () => {
    const violations = await check({
      "packages/protocol/data.json": "{}",
      "packages/pi-adapter/src/index.ts": 'import "../../protocol/data.json";',
    });
    expect(violations).toEqual([
      "packages/pi-adapter/src/index.ts: private package import ../../protocol/data.json",
    ]);
  });

  test("a forbidden edge to a non-src file is still an edge", async () => {
    const violations = await check({
      "apps/host/dist.js": "",
      "apps/web/src/main.ts": 'import "../../host/dist.js";',
    });
    expect(violations.some((v) => v.includes("forbidden app edge"))).toBe(true);
  });
});
