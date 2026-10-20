import { test, expect } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, cp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  inventory,
  atomicJson,
  digest,
} from "../../scripts/build-manifests.mjs";
import { canonicalJson } from "../../packages/protocol/src/updates.js";

test.each([
  [
    "export async function startHost(){throw Object.assign(Error('DO_NOT_LOG_PRIVATE_SENTINEL'),{detail:{stage:'control',code:'CONTROL_PATH_TOO_LONG'}})}",
    "host-start",
    "CONTROL_PATH_TOO_LONG",
  ],
  [
    "throw Object.assign(Error('DO_NOT_LOG_PRIVATE_SENTINEL'), {code:'ERR_MODULE_NOT_FOUND'});",
    "module-import",
    "HOST_MODULE_MISSING",
  ],
  [
    "export async function startHost(){throw Object.assign(Error('DO_NOT_LOG_PRIVATE_SENTINEL'),{code:'STORAGE_UNAVAILABLE'})}",
    "host-start",
    "STORAGE_UNAVAILABLE",
  ],
  [
    "export async function startHost(){throw TypeError('DO_NOT_LOG_PRIVATE_SENTINEL')}",
    "host-start",
    "HOST_INITIALIZATION_FAILED",
  ],
])(
  "retained launcher reports bounded stage before failing connection: %s",
  async (source, stage, code) => {
    const root = await mkdtemp(join(tmpdir(), "suri-launch-feedback-"));
    try {
      const image = join(root, "image"),
        data = join(root, "data");
      await mkdir(join(image, "dist/apps/host/src"), { recursive: true });
      await cp(
        resolve("scripts/update-launcher.mjs"),
        join(image, "launch.mjs"),
      );
      await writeFile(join(image, "package.json"), '{"type":"module"}');
      await writeFile(join(image, "dist/apps/host/src/host.js"), source);
      const identity = {
        schema: 1,
        kind: "host",
        compatibility: {
          protocol: 1,
          hostMin: 2,
          hostMax: 2,
          checkpoint: 1,
          shellMin: 2,
        },
        storageSchema: 1,
        node: {
          version: process.versions.node,
          abi: process.versions.modules,
          platform: process.platform,
          arch: process.arch,
        },
        adapterId: "a".repeat(64),
        files: await inventory(image),
      };
      const buildId = digest(canonicalJson(identity));
      await atomicJson(join(image, "manifest.json"), {
        buildId,
        identity,
        createdAt: new Date().toISOString(),
      });
      const result = await promisify(execFile)(
        process.execPath,
        [join(image, "launch.mjs"), "serve"],
        {
          env: { ...process.env, SURI_DATA_DIR: data, SURI_ASSETS_DIR: root },
          timeout: 10000,
        },
      ).then(
        () => ({ stderr: "" }),
        (error) => ({ stderr: error.stderr }),
      );
      const report = await readFile(
        join(data, "run/update-launch.json"),
        "utf8",
      );
      expect(JSON.parse(report)).toMatchObject({
        stage: "failed",
        failedStage: stage,
        code,
      });
      expect(report + result.stderr).not.toContain(
        "DO_NOT_LOG_PRIVATE_SENTINEL",
      );
      expect(report).not.toContain(root);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
