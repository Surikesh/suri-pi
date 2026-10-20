import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { analyzeBoundaries } from "./boundaries-lib.mjs";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const roots = process.argv.slice(2);
// Without explicit roots, every packages/*/src plus apps/web/src and apps/host/src are discovered.
const violations = await analyzeBoundaries(roots.length > 0 ? roots : null, {
  projectRoot,
});
if (violations.length > 0) {
  console.error(violations.join("\n"));
  process.exit(1);
}
console.log("Suri frontend/runtime boundaries: OK");
