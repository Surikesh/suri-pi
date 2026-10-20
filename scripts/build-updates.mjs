import { execFileSync } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { compileHelper } from "./native-helper.mjs";
import { buildHost } from "./build-host.mjs";
import { buildUi } from "./build-ui.mjs";

// Staging never rewrites legacy dist/ui or executable files used by a live host.
if (process.versions.node !== "24.15.0")
  throw Error("HOST_NODE_VERSION_UNSUPPORTED");
const root = process.cwd();
const compiledRoot = join(root, ".build", "compile-stage-" + randomUUID());
await mkdir(join(compiledRoot, "native"), { recursive: true });
try {
  execFileSync(
    process.execPath,
    [join(root, "node_modules/typescript/bin/tsc"), "--outDir", compiledRoot],
    { cwd: root, stdio: "inherit", timeout: 120000 },
  );
  compileHelper(join(compiledRoot, "native/suri-helper"), {
    cwd: root,
    flags: ["-O2"],
  });
  const host = await buildHost({ root, compiledRoot, modern: true });
  const ui = await buildUi({ root });
  console.log(
    JSON.stringify({
      hostBuildId: host.buildId,
      uiBuildId: ui.buildId,
      activated: false,
    }),
  );
} finally {
  await rm(compiledRoot, { recursive: true, force: true });
}
