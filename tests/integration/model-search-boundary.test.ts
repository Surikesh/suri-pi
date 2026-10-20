import { expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { browserHost } from "../support/browser-host.js";

it("keeps creation and listing passive, then discovers and sets before a prompt", async () => {
  const fixture = await browserHost();
  try {
    expect(fixture.host.children.size).toBe(0);
    await expect(
      fixture.execute("model.list", {}, fixture.session.id),
    ).rejects.toThrow(/resume/i);
    expect(fixture.host.children.size).toBe(0);
    await fixture.execute("session.resume", {}, fixture.session.id);
    await expect.poll(() => fixture.host.children.size).toBe(1);
    const result = await fixture.execute("model.list", {}, fixture.session.id);
    expect(result.models.map((model: any) => model.id)).toContain("alternate");
    const revision = fixture.host.store.get(
      "session",
      fixture.session.id,
    ).revision;
    await fixture.execute(
      "model.set",
      { provider: "synthetic", id: "alternate" },
      fixture.session.id,
      revision,
    );
    await expect
      .poll(
        () => fixture.host.store.get("session", fixture.session.id).model?.id,
      )
      .toBe("alternate");
    const calls = (
      await readFile(join(fixture.workspace, "rpc-calls.jsonl"), "utf8")
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const available = calls.find(
      (call) => call.type === "get_available_models",
    );
    expect(available).toBeDefined();
    expect(Object.keys(available).sort()).toEqual(["id", "type"]);
    expect(calls.some((call) => call.type === "set_model")).toBe(true);
    expect(calls.some((call) => call.type === "get_state")).toBe(true);
    expect(calls.some((call) => call.type === "prompt")).toBe(false);
  } finally {
    await fixture.close();
  }
});
