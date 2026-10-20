import { z } from "zod";

// Wire major remains 1. Do not advertise updates-v1 until the transition owner exists.
export const UPDATE_SCHEMA = 1;
export const UPDATE_UI_CONTRACT = 2;
export const UPDATE_SHELL_CONTRACT = 2;
export const BuildIdSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const UpdatePathSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine(
    (path) =>
      !/[\\\u0000:]/.test(path) &&
      path
        .split("/")
        .every((part) => part !== "" && part !== "." && part !== ".."),
    "Noncanonical artifact path",
  );
const integer = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const CompatibilitySchema = z
  .strictObject({
    protocol: z.literal(1),
    hostMin: integer.min(1),
    hostMax: integer.min(1),
    checkpoint: z.literal(1),
    shellMin: integer.min(1),
  })
  .refine((value) => value.hostMin <= value.hostMax, "Reversed host range");
export const InventoryFileSchema = z.strictObject({
  path: UpdatePathSchema,
  sha256: BuildIdSchema,
  bytes: integer.max(64 * 1024 * 1024),
  executable: z.boolean(),
});
export const InventorySchema = z
  .array(InventoryFileSchema)
  .min(1)
  .max(10_000)
  .superRefine((files, ctx) => {
    const paths = new Set<string>();
    let total = 0;
    for (const file of files) {
      total += file.bytes;
      if (paths.has(file.path))
        ctx.addIssue({ code: "custom", message: "Duplicate inventory path" });
      paths.add(file.path);
    }
    for (const path of paths) {
      const parts = path.split("/");
      parts.pop();
      while (parts.length) {
        if (paths.has(parts.join("/")))
          ctx.addIssue({ code: "custom", message: "File/directory collision" });
        parts.pop();
      }
    }
    if (total > 512 * 1024 * 1024)
      ctx.addIssue({ code: "custom", message: "Inventory exceeds size limit" });
  });
export const UiIdentitySchema = z
  .strictObject({
    schema: z.literal(1),
    kind: z.literal("ui"),
    compatibility: CompatibilitySchema,
    entry: UpdatePathSchema,
    files: InventorySchema,
  })
  .superRefine((value, ctx) => {
    const paths = new Set(value.files.map((file) => file.path));
    if (
      !paths.has("index.html") ||
      !paths.has(value.entry) ||
      !/\.m?js$/.test(value.entry)
    )
      ctx.addIssue({ code: "custom", message: "Entry missing from inventory" });
    if (paths.has("manifest.json") || paths.has("ready.json"))
      ctx.addIssue({ code: "custom", message: "Reserved metadata path" });
  });
export const UiManifestSchema = z.strictObject({
  buildId: BuildIdSchema,
  identity: UiIdentitySchema,
  createdAt: z.iso.datetime(),
});
export const ReadyPointerSchema = z.strictObject({
  schema: z.literal(1),
  generation: integer.min(1),
  buildId: BuildIdSchema,
});
export const HostIdentitySchema = z
  .strictObject({
    schema: z.literal(1),
    kind: z.literal("host"),
    compatibility: CompatibilitySchema,
    storageSchema: z.literal(1),
    node: z.strictObject({
      version: z.literal("24.15.0"),
      abi: z.string().regex(/^\d+$/),
      platform: z.enum(["darwin", "linux"]),
      arch: z.enum(["arm64", "x64"]),
    }),
    adapterId: BuildIdSchema,
    files: InventorySchema,
  })
  .superRefine((value, ctx) => {
    const paths = new Set(value.files.map((file) => file.path));
    for (const path of [
      "launch.mjs",
      "package.json",
      "dependencies.json",
      "dist/apps/host/src/host.js",
      "dist/apps/host/src/cli.js",
      "dist/packages/pi-adapter/src/index.js",
      "dist/packages/protocol/src/index.js",
      "dist/native/suri-helper",
    ]) {
      if (!paths.has(path))
        ctx.addIssue({
          code: "custom",
          message: "Required host payload missing",
        });
    }
    if (paths.has("manifest.json") || paths.has("ready.json"))
      ctx.addIssue({ code: "custom", message: "Reserved metadata path" });
  });
export const HostManifestSchema = z.strictObject({
  buildId: BuildIdSchema,
  identity: HostIdentitySchema,
  createdAt: z.iso.datetime(),
});
export type UiManifest = z.infer<typeof UiManifestSchema>;
export type HostManifest = z.infer<typeof HostManifestSchema>;
export type InventoryFile = z.infer<typeof InventoryFileSchema>;

// Canonical serialization is shared by producers and consumers; timestamps are
// deliberately outside the logical identity. Arrays preserve semantic ordering.
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value))
    return JSON.stringify(value);
  if (Array.isArray(value))
    return "[" + value.map(canonicalJson).join(",") + "]";
  if (typeof value === "object" && value !== null)
    return (
      "{" +
      Object.keys(value)
        .sort()
        .map(
          (key) =>
            JSON.stringify(key) +
            ":" +
            canonicalJson((value as Record<string, unknown>)[key]),
        )
        .join(",") +
      "}"
    );
  throw new Error("Noncanonical identity value");
}
export function canonicalInventory(files: InventoryFile[]): InventoryFile[] {
  return InventorySchema.parse(files).sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  );
}
