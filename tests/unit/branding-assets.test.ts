import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";

const root = resolve(import.meta.dirname, "../..");
const publicDir = resolve(root, "apps/web/public");

describe("Suri Pi branding assets", () => {
  test("the browser and Harness use the same safe vector icon", async () => {
    const [html, branding, app, sidebar, browserIcon, harnessIcon] =
      await Promise.all([
        readFile(resolve(root, "apps/web/index.html"), "utf8"),
        readFile(resolve(root, "apps/web/src/branding.ts"), "utf8"),
        readFile(
          resolve(root, "apps/web/src/features/transcript/messages.tsx"),
          "utf8",
        ),
        readFile(
          resolve(root, "apps/web/src/features/sidebar/sidebar.tsx"),
          "utf8",
        ),
        readFile(resolve(publicDir, "icon.svg"), "utf8"),
        readFile(resolve(root, ".dsh/icon.svg"), "utf8"),
      ]);

    expect(html).toContain('rel="icon" type="image/svg+xml" href="/icon.svg"');
    expect(html).toContain('rel="manifest" href="/site.webmanifest"');
    expect(branding).toContain('appIcon = "/icon.svg"');
    expect(sidebar).toContain('className="brand-mark" src={appIcon}');
    expect(app).toContain('className="empty-mark" src={appIcon}');
    expect(browserIcon).toBe(harnessIcon);
    expect(browserIcon).toMatch(/width="20" height="20" viewBox="0 0 20 20"/);
    expect(browserIcon).not.toMatch(
      /<(?:script|foreignObject)\b|\burl\s*\(|\bon[a-z]+\s*=|\b(?:href|src)\s*=/i,
    );
  });

  test.each([
    ["favicon-32x32.png", 32],
    ["apple-touch-icon.png", 180],
    ["icon-192.png", 192],
    ["icon-512.png", 512],
  ])("%s is a square PNG with alpha", async (name, size) => {
    const bytes = await readFile(resolve(publicDir, name));
    expect(bytes.subarray(0, 8)).toEqual(
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    );
    expect(bytes.readUInt32BE(16)).toBe(size);
    expect(bytes.readUInt32BE(20)).toBe(size);
    expect([4, 6]).toContain(bytes[25]);
  });

  test("the macOS icon generator consumes the browser vector", async () => {
    const packageScript = await readFile(
      resolve(root, "scripts/package-macos.mjs"),
      "utf8",
    );
    expect(packageScript).toContain('resolve("apps/web/public/icon.svg")');
  });
});
