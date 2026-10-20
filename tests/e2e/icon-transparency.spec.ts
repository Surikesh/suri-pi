import { test, expect } from "@playwright/test";
import { browserHost } from "../support/browser-host.js";

for (const format of ["png", "svg"] as const) {
  test(`${format} project icon upload retains transparent pixels`, async ({
    page,
  }) => {
    const fixture = await browserHost();
    try {
      await fixture.login(page);
      await expect(page.locator(".shell")).toBeVisible();
      const png = await page.evaluate(() => {
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = 16;
        const ctx = canvas.getContext("2d")!;
        ctx.fillStyle = "red";
        ctx.fillRect(4, 4, 8, 8);
        return canvas.toDataURL("image/png").split(",")[1];
      });
      const buffer =
        format === "png"
          ? Buffer.from(png, "base64")
          : Buffer.from(
              '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect x="4" y="4" width="8" height="8" fill="red"/></svg>',
            );
      const chooserPromise = page.waitForEvent("filechooser");
      const icon = page.getByRole("button", {
        name: `Set icon for ${fixture.project.label}`,
        exact: true,
      });
      await icon.click();
      await (
        await chooserPromise
      ).setFiles({
        name: `alpha.${format}`,
        mimeType: format === "png" ? "image/png" : "image/svg+xml",
        buffer,
      });
      const displayed = icon.locator("img");
      await expect(displayed).toBeVisible();
      await page.reload();
      await expect(displayed).toBeVisible();
      const pixels = await displayed.evaluate(async (element) => {
        const image = element as HTMLImageElement;
        await image.decode();
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = 16;
        const ctx = canvas.getContext("2d")!;
        ctx.drawImage(image, 0, 0);
        return {
          corner: ctx.getImageData(0, 0, 1, 1).data[3],
          center: ctx.getImageData(8, 8, 1, 1).data[3],
          background: getComputedStyle(image.parentElement!).backgroundColor,
          fit: getComputedStyle(image).objectFit,
        };
      });
      expect(pixels).toEqual({
        corner: 0,
        center: 255,
        background: "rgba(0, 0, 0, 0)",
        fit: "contain",
      });
      if (format === "png") {
        const uploaded = await page.request.get(
          new URL((await displayed.getAttribute("src"))!, page.url()).href,
        );
        expect(await uploaded.body()).toEqual(buffer);
      }
    } finally {
      await page.close();
      await fixture.close();
    }
  });
}
