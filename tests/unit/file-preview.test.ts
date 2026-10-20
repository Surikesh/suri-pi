import { describe, expect, it, vi } from "vitest";
import React from "react";
import { renderToPipeableStream } from "react-dom/server";
import { PassThrough } from "node:stream";
import {
  FileContent,
  FileTypeIcon,
  fileType,
} from "../../apps/web/src/file-preview.js";

vi.mock("../../apps/web/src/store.js", () => ({ command: vi.fn() }));

function markup(element: React.ReactElement): Promise<string> {
  return new Promise((resolve, reject) => {
    const destination = new PassThrough();
    let html = "";
    destination.on("data", (chunk) => {
      html += String(chunk);
    });
    destination.on("end", () => resolve(html));
    const stream = renderToPipeableStream(element, {
      onAllReady() {
        stream.pipe(destination);
      },
      onError: reject,
    });
  });
}
describe("file previews", () => {
  it("renders Markdown as a document and keeps a source switch", async () => {
    const html = await markup(
      React.createElement(FileContent, {
        path: "README.md",
        text: "# Read me\n\nA **document**.",
      }),
    );
    expect(html).toContain("<h1>Read me</h1>");
    expect(html).toContain("<strong>document</strong>");
    expect(html).toContain('aria-pressed="false">Source');
  });
  it("opens explicit line links in source mode so their target can be found", async () => {
    const html = await markup(
      React.createElement(FileContent, {
        path: "README.md",
        text: "# Read me\nsecond",
        line: 2,
      }),
    );
    expect(html).toContain('class="file-line selected" data-line="2"');
    expect(html).not.toContain("<h1>");
  });
  it("escapes source text and strips unsafe Markdown links", async () => {
    const source = await markup(
      React.createElement(FileContent, {
        path: "index.ts",
        text: "<script>alert(1)</script>",
      }),
    );
    expect(source).toContain("&lt;script&gt;");
    const doc = await markup(
      React.createElement(FileContent, {
        path: "README.md",
        text: "[bad](javascript:alert)",
      }),
    );
    expect(doc).not.toContain("javascript:");
  });
  it("distinguishes the requested file types without case sensitivity", () => {
    expect(
      [
        "README.MD",
        "app.tsx",
        "package.json",
        "icon.PNG",
        "config.yaml",
        "unknown.bin",
      ].map((path) => fileType(path).kind),
    ).toEqual(["markdown", "react", "node", "image", "yaml", "other"]);
  });
  it("matches the Harness rules for special and compound filenames", () => {
    expect(
      [
        "Dockerfile",
        ".gitignore",
        ".env.production",
        "app.component.ts",
        "CMakeLists.txt",
        "Makefile",
        "report.pdf",
      ].map((path) => fileType(path).kind),
    ).toEqual(["docker", "git", "env", "angular", "cmake", "makefile", "pdf"]);
  });
  it("renders semantic SVG artwork instead of text placeholders", async () => {
    const html = await markup(
      React.createElement(FileTypeIcon, { path: "package.json" }),
    );
    expect(html).toContain('class="file-type-icon node"');
    expect(html).toContain("<svg");
    expect(html).not.toContain("&gt;{}&lt;");
    const fallback = await markup(
      React.createElement(FileTypeIcon, { path: "unknown.bin" }),
    );
    expect(fallback).toContain("file-icon-paper");
    expect(fallback).toContain('viewBox="0 0 20 20"');
    expect(fileType("rpc-calls.jsonl").kind).toBe("json");
    expect(fileType("tsconfig.tsbuildinfo").kind).toBe("typescript");
    expect(fileType("agent.log").kind).toBe("log");
    expect(fileType("notes.txt").kind).toBe("text");
    expect(fileType("release.tar.gz").kind).toBe("archive");
    expect(fileType("unknown.bin").kind).toBe("other");
  });
});
