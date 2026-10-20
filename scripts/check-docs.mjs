// Documentation guard: in README.md and docs/**/*.md every `npm run X` names a
// package.json script, every relative link resolves (including heading anchors in
// other Markdown files) and every backticked repository path exists.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, normalize } from "node:path";

const scripts = JSON.parse(readFileSync("package.json", "utf8")).scripts;
const lifecycle = new Set(["start", "stop", "test", "restart"]);

function markdownFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory()
      ? markdownFiles(path)
      : path.endsWith(".md")
        ? [path]
        : [];
  });
}

const slug = (heading) =>
  heading
    .toLowerCase()
    .replace(/`/g, "")
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .trim()
    .replace(/\s/g, "-");
const anchors = (file) =>
  new Set(
    [...readFileSync(file, "utf8").matchAll(/^#{1,6}\s+(.+)$/gm)].map((m) =>
      slug(m[1]),
    ),
  );

const files = ["README.md", ...markdownFiles("docs")];
const problems = [];
for (const file of files) {
  const text = readFileSync(file, "utf8");
  for (const m of text.matchAll(/npm (?:run(?:-script)? )?([a-z][\w:.-]*)/g)) {
    const name = m[1];
    const isRun = m[0].startsWith("npm run");
    if (isRun ? !(name in scripts) : lifecycle.has(name) && !(name in scripts))
      problems.push(`${file}: npm script "${name}" does not exist`);
  }
  for (const m of text.matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
    const [target, hash] = m[1].split("#");
    if (/^(https?:|mailto:)/.test(m[1])) continue;
    const path = target ? normalize(join(dirname(file), target)) : file;
    if (!existsSync(path)) {
      problems.push(`${file}: broken link ${m[1]}`);
    } else if (hash && path.endsWith(".md") && !anchors(path).has(hash)) {
      problems.push(`${file}: missing anchor ${m[1]}`);
    }
  }
  for (const m of text.matchAll(/`([^`\s]+)`/g)) {
    const token = m[1].replace(/:\d+$/, "").replace(/\/$/, "");
    if (
      /^(?:apps|packages|scripts|tests|docs|native|runtime-locks|\.pi|\.github)\/[\w./@-]+$/.test(
        token,
      ) &&
      !existsSync(token)
    )
      problems.push(`${file}: path does not exist \`${m[1]}\``);
  }
}
if (problems.length) {
  console.error(problems.join("\n"));
  process.exit(1);
}
console.log(`Checked ${files.length} Markdown files.`);
