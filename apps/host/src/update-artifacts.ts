import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  lstat,
  open,
  readFile,
  readdir,
  mkdir,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { safePath } from "./resource-path.js";
import {
  canonicalJson,
  canonicalInventory,
  UiManifestSchema,
  HostManifestSchema,
  BuildIdSchema,
  type InventoryFile,
} from "../../../packages/protocol/src/updates.js";

type ArtifactFailureCode =
  | "CANDIDATE_INTEGRITY"
  | "CHECKOUT_CHANGED"
  | "CONTRACT_INCOMPATIBLE"
  | "STORAGE_UNAVAILABLE"
  | "CANDIDATE_LIMIT";
export class ArtifactFailure extends Error {
  constructor(readonly code: ArtifactFailureCode) {
    super(code);
  }
}
export type CheckoutIdentity = { path: string; device: string; inode: string };
export async function checkoutIdentity(
  path: string,
): Promise<CheckoutIdentity> {
  const canonical = await realpath(path);
  const stat = await lstat(canonical, { bigint: true });
  if (!stat.isDirectory()) throw new ArtifactFailure("CHECKOUT_CHANGED");
  const pkg = JSON.parse(
    await readFile(join(canonical, "package.json"), "utf8"),
  );
  if (
    pkg.name !== "suri-pi" ||
    !(await lstat(join(canonical, "dist/apps/host/src/cli.js"))).isFile()
  )
    throw new ArtifactFailure("CHECKOUT_CHANGED");
  return { path: canonical, device: String(stat.dev), inode: String(stat.ino) };
}
const hash = (bytes: string | Buffer) =>
  createHash("sha256").update(bytes).digest("hex");
async function privateInventory(
  root: string,
  prefix = "",
  files: InventoryFile[] = [],
): Promise<InventoryFile[]> {
  if (
    !(await lstat(root)).isDirectory() ||
    (await lstat(root)).isSymbolicLink()
  )
    throw new ArtifactFailure("CANDIDATE_INTEGRITY");
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = prefix + entry.name;
    if (entry.isDirectory())
      await privateInventory(join(root, entry.name), path + "/", files);
    else {
      if (!entry.isFile()) throw new ArtifactFailure("CANDIDATE_INTEGRITY");
      if (!prefix && ["manifest.json", "ready.json"].includes(entry.name))
        continue;
      const stat = await lstat(join(root, entry.name));
      if (stat.size > 64 * 1024 * 1024)
        throw new ArtifactFailure("CANDIDATE_LIMIT");
      const bytes = await readFile(join(root, entry.name));
      files.push({
        path,
        bytes: bytes.length,
        sha256: hash(bytes),
        executable: (stat.mode & 0o111) !== 0,
      });
      if (files.length > 10_000) throw new ArtifactFailure("CANDIDATE_LIMIT");
    }
  }
  return canonicalInventory(files);
}
export async function validatePrivateArtifact(
  root: string,
  kind: "ui" | "host",
  expectedId: string,
) {
  try {
    BuildIdSchema.parse(expectedId);
    for (const name of ["manifest.json", "ready.json"]) {
      const stat = await lstat(join(root, name));
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.size > 4 * 1024 * 1024
      )
        throw new ArtifactFailure("CANDIDATE_INTEGRITY");
    }
    const raw = JSON.parse(await readFile(join(root, "manifest.json"), "utf8"));
    const manifest =
      kind === "ui"
        ? UiManifestSchema.parse(raw)
        : HostManifestSchema.parse(raw);
    const ready = JSON.parse(await readFile(join(root, "ready.json"), "utf8"));
    if (
      ready.schema !== 1 ||
      ready.buildId !== expectedId ||
      manifest.buildId !== expectedId ||
      hash(canonicalJson(manifest.identity)) !== expectedId
    )
      throw new ArtifactFailure("CANDIDATE_INTEGRITY");
    if (
      canonicalJson(await privateInventory(root)) !==
      canonicalJson(manifest.identity.files)
    )
      throw new ArtifactFailure("CANDIDATE_INTEGRITY");
    return manifest;
  } catch (error) {
    if (error instanceof ArtifactFailure) throw error;
    throw new ArtifactFailure("CANDIDATE_INTEGRITY");
  }
}
const execute = promisify(execFile);
export class ImmutableArtifacts {
  constructor(
    readonly dataRoot: string,
    readonly helper: string,
  ) {}
  async import(checkout: CheckoutIdentity, kind: "ui" | "host", id: string) {
    return this.snapshot(checkout, `.build/${kind}/${id}`, kind, id);
  }
  async readUiFile(id: string, path: string) {
    safePath(path);
    BuildIdSchema.parse(id);
    const root = join(await realpath(this.dataRoot), "ui-builds", id);
    const manifest = UiManifestSchema.parse(
      JSON.parse(await readFile(join(root, "manifest.json"), "utf8")),
    );
    if (
      manifest.buildId !== id ||
      hash(canonicalJson(manifest.identity)) !== id
    )
      throw new ArtifactFailure("CANDIDATE_INTEGRITY");
    const file = manifest.identity.files.find((file) => file.path === path);
    // Unlisted names are absent, not corrupt: HTTP maps ENOENT to a 404.
    if (!file)
      throw Object.assign(new Error("UI file is not listed."), {
        code: "ENOENT",
      });
    try {
      const { stdout } = await execute(
        this.helper,
        ["update-read", root, path],
        { encoding: "buffer", timeout: 10_000, maxBuffer: 64 * 1024 * 1024 },
      );
      if (stdout.length !== file.bytes || hash(stdout) !== file.sha256)
        throw new ArtifactFailure("CANDIDATE_INTEGRITY");
      return stdout;
    } catch {
      throw new ArtifactFailure("CANDIDATE_INTEGRITY");
    }
  }
  async baseline(source: string) {
    const canonical = await realpath(source);
    const parent = dirname(canonical);
    const identity = await lstat(parent, { bigint: true });
    const manifest = UiManifestSchema.parse(
      JSON.parse(await readFile(join(canonical, "manifest.json"), "utf8")),
    );
    return this.snapshot(
      {
        path: parent,
        device: String(identity.dev),
        inode: String(identity.ino),
      },
      basename(canonical),
      "ui",
      manifest.buildId,
    );
  }
  private async snapshot(
    checkout: CheckoutIdentity,
    relativeSource: string,
    kind: "ui" | "host",
    id: string,
  ) {
    if (!BuildIdSchema.safeParse(id).success)
      throw new ArtifactFailure("CANDIDATE_INTEGRITY");
    const store = join(this.dataRoot, `${kind}-builds`);
    await mkdir(store, { recursive: true, mode: 0o700 });
    const stage = join(store, ".stage-" + randomUUID());
    await mkdir(stage, { mode: 0o700 });
    try {
      try {
        await execute(
          this.helper,
          [
            "update-snapshot",
            checkout.path,
            relativeSource,
            checkout.device,
            checkout.inode,
            await realpath(stage),
          ],
          { timeout: 30_000, maxBuffer: 1024 },
        );
      } catch (error) {
        const code = (error as { code?: number }).code;
        throw new ArtifactFailure(
          code === 21
            ? "CHECKOUT_CHANGED"
            : code === 22
              ? "CANDIDATE_LIMIT"
              : code === 20
                ? "CANDIDATE_INTEGRITY"
                : "STORAGE_UNAVAILABLE",
        );
      }
      const manifest = await validatePrivateArtifact(stage, kind, id);
      const target = join(store, id);
      try {
        await rename(stage, target);
      } catch (error) {
        if (
          !["EEXIST", "ENOTEMPTY"].includes(
            (error as NodeJS.ErrnoException).code ?? "",
          )
        )
          throw new ArtifactFailure("STORAGE_UNAVAILABLE");
        await validatePrivateArtifact(target, kind, id);
      }
      const directory = await open(store, "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
      return { manifest, path: target };
    } finally {
      await rm(stage, { recursive: true, force: true });
    }
  }
}
