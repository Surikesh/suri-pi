import { test, expect } from "@playwright/test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { browserHost } from "../support/browser-host.js";

for (const viewport of [
  { name: "desktop", width: 1280, height: 850 },
  { name: "narrow", width: 430, height: 780 },
]) {
  test(`startup failure stays retryable without implicit reboot (${viewport.name})`, async ({
    page,
  }) => {
    const fixture = await browserHost();
    try {
      await page.setViewportSize(viewport);
      const executable = join(fixture.root, "fake-pi", "dist", "cli.mjs");
      const counter = join(fixture.root, "startup-count");
      await writeFile(
        executable,
        `#!/usr/bin/env node
import fs from 'node:fs';
const counter=${JSON.stringify(counter)};
let count=0; try { count=Number(fs.readFileSync(counter,'utf8'))||0 } catch {}
fs.writeFileSync(counter,String(count+1));
let input=''; process.stdin.on('data',chunk=>{ input+=chunk; while(input.includes('\\n')) { const i=input.indexOf('\\n'); const request=JSON.parse(input.slice(0,i)); input=input.slice(i+1); if(request.type==='get_state') process.stdout.write(JSON.stringify({type:'response',id:request.id,command:request.type,success:true,data:{model:{provider:'fixture',id:'other'}}})+'\\n'); else if(request.type==='set_model') setTimeout(()=>process.exit(9),120); }});
`,
        { mode: 0o755 },
      );
      const session = fixture.host.store.get("session", fixture.session.id);
      fixture.host.store.put("session", {
        ...session,
        model: { provider: "fixture", id: "wanted" },
      });

      await fixture.execute("session.resume", {}, fixture.session.id);
      await expect
        .poll(
          () =>
            fixture.host.store.snapshot(`session:${fixture.session.id}`).phase,
        )
        .toBe("failed");
      expect(await readFile(counter, "utf8")).toBe("1");

      await fixture.login(page);
      await page.evaluate((id) => {
        localStorage.setItem(`suri.draft.${id}`, "draft survives startup");
        localStorage.setItem(
          `suri.attachments.${id}`,
          JSON.stringify([
            { id: "asset-1", name: "proof.txt", mime: "text/plain", bytes: 12 },
          ]),
        );
      }, fixture.session.id);
      await page.reload();
      const editor = page.getByRole("textbox", { name: "Message Pi" });
      await expect(editor).toHaveValue("draft survives startup");
      await expect(page.getByLabel("Pending attachments")).toContainText(
        "proof.txt",
      );
      await expect(
        page.getByRole("button", { name: "Retry startup" }),
      ).toBeVisible();
      await editor.focus();

      await page.waitForTimeout(350);
      await page.reload();
      await expect(
        page.getByRole("button", { name: "Retry startup" }),
      ).toBeVisible();
      expect(await readFile(counter, "utf8")).toBe("1");
      await editor.focus();
      await page
        .getByRole("button", { name: "Retry startup" })
        .evaluate((button: HTMLButtonElement) => button.click());
      await expect
        .poll(async () => Number(await readFile(counter, "utf8")))
        .toBe(2);
      await expect
        .poll(
          () =>
            fixture.host.store.snapshot(`session:${fixture.session.id}`).phase,
        )
        .toBe("failed");
      await expect(editor).toHaveValue("draft survives startup");
      await expect(page.getByLabel("Pending attachments")).toContainText(
        "proof.txt",
      );
      await expect(editor).toBeFocused();
      await page.waitForTimeout(300);
      expect(await readFile(counter, "utf8")).toBe("2");
      await expect(
        page.getByRole("button", { name: "Retry startup" }),
      ).toBeVisible();
    } finally {
      await fixture.close();
    }
  });
}
