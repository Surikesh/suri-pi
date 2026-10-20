import { Assets } from "../dist/apps/host/src/assets.js";
import { startHost } from "../dist/apps/host/src/host.js";
import { mkdtemp, writeFile, readFile, mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
const root = await mkdtemp(join(tmpdir(), "suri-e2e-"));
await mkdir(".suri-local", { recursive: true });
await writeFile(".suri-local/e2e-root", root);
await writeFile(join(root, "hello.txt"), "hello");
await mkdir(join(root, "folder"));
await writeFile(join(root, "folder", "nested.txt"), "nested");
await mkdir(join(root, "accidental-chromium"));
await mkdir(join(root, "accidental-webkit"));
await writeFile(join(root, ".hidden-fixture"), "hidden");
await Promise.all(
  Array.from({ length: 501 }, (_, index) =>
    writeFile(join(root, `page-${String(index).padStart(3, "0")}.txt`), "page"),
  ),
);
const host = await startHost({
  simulated: true,
  root,
  assets: resolve("dist/ui"),
  helper: resolve("dist/native/suri-helper"),
  port: Number(process.env.SURI_E2E_PORT ?? 4310),
});
const project = { id: randomUUID(), label: "Suri fixture", root, revision: 1 };
const workspace = {
  id: randomUUID(),
  projectId: project.id,
  label: "Suri fixture",
  root,
  revision: 1,
};
const session = {
  id: randomUUID(),
  workspaceId: workspace.id,
  name: "A quiet place to build",
  runtimeId: randomUUID(),
  revision: 1,
  archived: false,
  model: { provider: "synthetic", id: "fixture-model" },
  thinkingLevel: "medium",
  createdAt: new Date(Date.now() - 60_000).toISOString(),
  updatedAt: new Date(Date.now() - 60_000).toISOString(),
};
host.store.put("project", project);
host.store.put("workspace", workspace);
const secondWorkspace = {
  ...workspace,
  id: randomUUID(),
  label: "Second workspace",
  root: join(root, "folder"),
};
host.store.put("workspace", secondWorkspace);
host.store.put("runtime", {
  id: session.runtimeId,
  executable: "/fixture",
  version: "fixture",
  identity: "synthetic",
  status: "candidate",
  revision: 1,
});
host.store.put("session", session);
const runningSession = {
  ...session,
  id: randomUUID(),
  name: "Running session",
};
host.store.put("session", runningSession);
host.publish(`session:${runningSession.id}`, "run.state", { phase: "running" });
host.store.put("session", {
  ...session,
  id: randomUUID(),
  workspaceId: secondWorkspace.id,
  name: "Second workspace session",
});
const unnamedSession = {
  ...session,
  id: randomUUID(),
  name: "New session",
  nameSource: "default",
};
host.store.put("session", unnamedSession);
const legacyUnnamedSession = {
  ...unnamedSession,
  id: randomUUID(),
  nameSource: undefined,
  updatedAt: new Date().toISOString(),
};
host.store.put("session", legacyUnnamedSession);
host.publish(`session:${legacyUnnamedSession.id}`, "message.upsert", {
  messageId: randomUUID(),
  role: "user",
  blocks: [
    {
      id: "legacy-prompt",
      kind: "text",
      text: "Legacy conversation that still needs a useful title",
    },
  ],
  revision: 1,
  final: true,
});
for (const browser of ["Chromium", "WebKit"]) {
  const removableProject = {
    id: randomUUID(),
    label: `Accidental project ${browser}`,
    root: join(root, `accidental-${browser.toLowerCase()}`),
    revision: 1,
  };
  host.store.put("project", removableProject);
  host.store.put("workspace", {
    id: randomUUID(),
    projectId: removableProject.id,
    label: removableProject.label,
    root: removableProject.root,
    revision: 1,
  });
}
const transcriptImage = await new Assets(host.store).upload(
  await readFile(resolve("apps/web/public/icon-192.png")),
  "Synthetic Suri fixture.png",
  "image/png",
  "attachment",
  session.id,
);
host.publish(`session:${session.id}`, "message.upsert", {
  messageId: randomUUID(),
  role: "user",
  blocks: [
    {
      id: "u1",
      kind: "text",
      text: "Read hello.txt and explain what you found. This deliberately longer synthetic request provides enough preceding content to exercise the lower transcript near the fixed composer at desktop and narrow widths without using a private conversation.",
    },
    {
      id: "u1-image",
      kind: "image",
      artifactId: transcriptImage.id,
    },
  ],
  revision: 1,
  final: true,
});
host.publish(`session:${session.id}`, "message.upsert", {
  messageId: randomUUID(),
  role: "custom",
  blocks: [
    {
      id: "internal-context",
      kind: "custom",
      text: "INTERNAL TELEMETRY FIXTURE MUST NOT APPEAR AS A CHAT TURN",
    },
  ],
  revision: 1,
  final: true,
});
const bridgedFilePath = join(secondWorkspace.root, "nested.txt");
const bridgedFileHref = `https://herdr-local-file.invalid/open?path=${encodeURIComponent(bridgedFilePath)}`;
host.publish(`session:${session.id}`, "message.upsert", {
  messageId: randomUUID(),
  role: "assistant",
  blocks: [
    {
      id: "a1",
      kind: "text",
      text: `## A small beginning\n\nThe file contains **hello**. Everything is ready for the next step. Open [hello.txt](hello.txt), or inspect \`hello.txt\` directly. The handoff is [open — ${bridgedFilePath}](${bridgedFileHref}).\n\n| File | Content |\n| --- | --- |\n| hello.txt | hello |\n\n\`\`\`ts\nexport const greeting = "hello";\n\`\`\`\n\n\`\`\`bash\nprintf "SURI_CODE_RUN_OK\\n"\n\`\`\``,
    },
    {
      id: "fixture-call",
      kind: "toolCall",
      callId: "fixture-read",
      name: "read",
      arguments: { path: "hello.txt" },
    },
    {
      id: "fixture-thinking",
      kind: "thinking",
      text: "Planning policy continuity investigation",
    },
    {
      id: "fixture-empty-between-activity",
      kind: "text",
      text: "",
    },
    {
      id: "fixture-failed-call",
      kind: "toolCall",
      callId: "fixture-bash",
      name: "bash",
      arguments: { command: "exit 1" },
    },
    {
      id: "fixture-inline-final",
      kind: "text",
      text: "The mixed assistant message resumes prose after its tool sequence.",
    },
  ],
  revision: 1,
  final: true,
});
host.publish(`session:${session.id}`, "message.upsert", {
  messageId: randomUUID(),
  role: "assistant",
  blocks: [
    {
      id: "fixture-activity-thinking",
      kind: "thinking",
      text: "Reading registration data",
    },
    {
      id: "fixture-write-call",
      kind: "toolCall",
      callId: "fixture-write",
      name: "write",
      arguments: { path: "/tmp/script.py", content: "print('fixture')" },
    },
    {
      id: "fixture-skill-call",
      kind: "toolCall",
      callId: "fixture-skill",
      name: "pending_wire_name",
      arguments: {},
    },
    {
      id: "fixture-retrying-call",
      kind: "toolCall",
      callId: "fixture-retrying",
      name: "bash",
      arguments: {
        command:
          "node scripts/resolve-route.mjs --with-a-deliberately-long-summary-that-must-not-expand-the-row",
      },
    },
  ],
  revision: 1,
  final: true,
});
host.publish(`session:${session.id}`, "message.upsert", {
  messageId: randomUUID(),
  role: "assistant",
  blocks: [
    {
      id: "fixture-empty-streaming-text",
      kind: "text",
      text: "",
    },
  ],
  revision: 1,
  final: true,
});
host.publish(`session:${session.id}`, "message.upsert", {
  messageId: randomUUID(),
  role: "assistant",
  blocks: [
    {
      id: "fixture-streaming-thinking",
      kind: "thinking",
      text: "Preparing the final response",
    },
    {
      id: "fixture-final-response",
      kind: "text",
      text: "Final response after tool activity.",
    },
  ],
  revision: 1,
  final: true,
});
host.publish(`session:${session.id}`, "tool.state", {
  callId: "fixture-read",
  name: "read",
  phase: "completed",
  blocks: [{ id: "read-result", kind: "text", text: "hello" }],
});
host.publish(`session:${session.id}`, "tool.state", {
  callId: "fixture-bash",
  name: "bash",
  phase: "failed",
  blocks: [{ id: "bash-result", kind: "text", text: "Synthetic failure" }],
});
host.publish(`session:${session.id}`, "tool.state", {
  callId: "fixture-write",
  name: "write",
  phase: "completed",
  blocks: [{ id: "write-result", kind: "text", text: "Wrote 16 bytes" }],
});
host.publish(`session:${session.id}`, "tool.state", {
  callId: "fixture-skill",
  name: "skill",
  arguments: { skill: "acme-frontend" },
  phase: "completed",
  blocks: [{ id: "skill-result", kind: "text", text: "Skill loaded" }],
});
host.publish(`session:${session.id}`, "tool.state", {
  callId: "fixture-retrying",
  name: "bash",
  arguments: { description: "Resolve bounded frontend route" },
  phase: "retrying",
  blocks: [],
});
host.publish(`session:${session.id}`, "tool.state", {
  callId: "fixture-stale-orphan",
  name: "read",
  arguments: { path: "stale-orphan.txt" },
  phase: "completed",
  blocks: [{ id: "stale-result", kind: "text", text: "stale" }],
});
host.publish(`session:${session.id}`, "tool.state", {
  callId: "fixture-active-orphan",
  name: "bash",
  arguments: { description: "active-orphan-must-not-float" },
  phase: "running",
  blocks: [],
});
host.publish(`session:${session.id}`, "usage.updated", {
  contextUsage: { tokens: 42000, contextWindow: 128000, percent: 32.8125 },
});
const richSession = {
  ...session,
  id: randomUUID(),
  name: "Untrusted content and artifacts",
  model: { provider: "synthetic", id: "other-model" },
  thinkingLevel: "high",
};
host.store.put("session", richSession);
const artifact = await new Assets(host.store).output(
  "synthetic output\n".repeat(10000),
  richSession.id,
);
host.publish(`session:${richSession.id}`, "message.upsert", {
  messageId: randomUUID(),
  role: "assistant",
  revision: 1,
  final: true,
  blocks: [
    {
      id: "untrusted",
      kind: "text",
      text: "<script>window.__suriXss=true</script>\n\n[unsafe](javascript:alert(1))\n\n![remote](https://invalid.example/private.png)",
    },
    {
      id: "artifact",
      kind: "text",
      text: "Large synthetic output",
      artifactId: artifact.id,
    },
  ],
});
const extensionSession = {
  ...session,
  id: randomUUID(),
  name: "Extension and queue fixture",
};
host.store.put("session", extensionSession);
host.publish(`session:${extensionSession.id}`, "extension.widget", {
  key: "fixture",
  lines: ["Synthetic extension widget"],
  placement: "aboveEditor",
});
host.publish(`session:${extensionSession.id}`, "extension.status", {
  key: "technical-mode",
  text: "tools: quiet",
});
host.publish(`session:${extensionSession.id}`, "extension.editor", {
  key: "editor",
  text: "Draft from extension fixture",
});
host.publish(`session:${extensionSession.id}`, "queue.state", {
  items: [
    {
      queueId: "fixture-steer",
      mode: "steer",
      text: "Synthetic queued steer",
    },
    {
      queueId: "fixture-follow-up",
      mode: "followUp",
      text: "Synthetic queued follow-up",
    },
  ],
});
process.on(
  "SIGTERM",
  () =>
    void host
      .close()
      .then(() => rm(root, { recursive: true, force: true }))
      .then(() => process.exit(0)),
);
