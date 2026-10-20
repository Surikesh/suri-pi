import { expect, it } from "vitest";
import { browserHost } from "../support/browser-host.js";

it("removes terminal controls from extension status before persistence", async () => {
  const fixture = await browserHost();
  try {
    await fixture.execute(
      "run.submit",
      { mode: "prompt", text: "ANSI_STATUS", attachmentIds: [] },
      fixture.session.id,
    );
    await expect
      .poll(() => {
        const extensions = fixture.host.store.snapshot(
          `session:${fixture.session.id}`,
        ).extensions;
        return Object.values(extensions ?? {}).find(
          (extension) => extension.key === "tools",
        )?.text;
      })
      .toBe("tools: quiet");
  } finally {
    await fixture.close();
  }
});
