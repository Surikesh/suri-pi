import { describe, expect, it } from "vitest";
import { sessionTitle } from "../../apps/host/src/session-name.js";

describe("sessionTitle", () => {
  it("uses a compact opening phrase", () => {
    expect(
      sessionTitle("Please fix the session menu focus and then run the tests"),
    ).toBe("Please fix the session menu focus and then");
  });

  it("normalizes markdown and limits long titles", () => {
    const title = sessionTitle(
      "# Investigate `commands.list` behaviour with an extraordinarilylongidentifierthatmustnotoverflow the sidebar",
    );
    expect(title).toBe("Investigate commands.list behaviour with an");
    expect(title.length).toBeLessThanOrEqual(58);
  });

  it("keeps the default for content without a useful title", () => {
    expect(sessionTitle("```ts\nconst value = 1;\n```")).toBe("New session");
  });
});
