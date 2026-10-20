import { describe, expect, it } from "vitest";
import { localFileLabel, localPath } from "../../apps/web/src/rich.js";

const root = "/Users/example/Developer/project";

describe("Markdown local links", () => {
  it("resolves Herdr bridge links to the underlying workspace file", () => {
    const path = `${root}/docs/Execution Plan.md`;
    const href = `https://herdr-local-file.invalid/open?path=${encodeURIComponent(path)}`;
    expect(localPath(href, root)).toBe(path);
  });

  it("renders bridge links as compact workspace-relative file labels", () => {
    const path = `${root}/docs/Execution Plan.md:42`;
    expect(localFileLabel(path, root)).toBe("docs/Execution Plan.md:42");
  });

  it("keeps ordinary web links external", () => {
    expect(localPath("https://example.com/guide", root)).toBeUndefined();
  });

  it("recognizes bridge paths outside the active workspace for registered-project routing", () => {
    const path = "/Users/example/Developer/another-project/plan.md";
    const href = `https://herdr-local-file.invalid/open?path=${encodeURIComponent(path)}`;
    expect(localPath(href, root)).toBe(path);
    expect(localFileLabel(path, root)).toBe("plan.md");
  });

  it("expands home-relative references for external-file routing instead of treating them as workspace paths", () => {
    expect(localPath("~/.pi/web-search.json", root)).toBe(
      "/Users/example/.pi/web-search.json",
    );
    expect(localFileLabel("/Users/example/.pi/web-search.json", root)).toBe(
      "web-search.json",
    );
  });

  it("does not guess a home directory from an unrelated workspace root", () => {
    expect(localPath("~/.pi/web-search.json", "/srv/project")).toBeUndefined();
  });

  it("continues to resolve relative workspace files", () => {
    expect(localPath("docs/guide.md", root)).toBe(`${root}/docs/guide.md`);
  });
});
