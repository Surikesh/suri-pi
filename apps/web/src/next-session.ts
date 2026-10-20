type NextSessionRequest = {
  planPath: string;
  name: string;
  dryRun: boolean;
};

const MAX_PLAN_PATH = 512;
const MAX_SESSION_NAME = 120;

export function parseNextSessionArgument(argument: string): NextSessionRequest {
  let value = argument.trim();
  let dryRun = false;
  if (/(?:^|\s)--dry-run(?:\s|$)/.test(value)) {
    dryRun = true;
    value = value.replace(/(?:^|\s)--dry-run(?=\s|$)/, " ").trim();
  }

  let explicitName = "";
  const nameMatch = value.match(
    /(?:^|\s)--name\s+(?:"([^"]+)"|'([^']+)'|(\S+))\s*$/,
  );
  if (nameMatch) {
    explicitName = (nameMatch[1] ?? nameMatch[2] ?? nameMatch[3] ?? "").trim();
    value = value.slice(0, nameMatch.index).trim();
  }
  const planPath = value.replace(/^(?:"([^"]+)"|'([^']+)')$/, "$1$2").trim();
  if (!planPath)
    throw Error(
      'Usage: /next-session <workspace-relative-plan.md> [--name "Session name"] [--dry-run]',
    );
  if (
    planPath.length > MAX_PLAN_PATH ||
    planPath.startsWith("/") ||
    planPath.includes("\\") ||
    planPath.split("/").includes("..") ||
    !planPath.toLowerCase().endsWith(".md")
  )
    throw Error("The plan must be a workspace-relative Markdown path.");
  if (explicitName.length > MAX_SESSION_NAME)
    throw Error(
      `The session name must be at most ${MAX_SESSION_NAME} characters.`,
    );

  const leaf = planPath.split("/").at(-1)!.replace(/\.md$/i, "");
  const generatedName = leaf
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
  return {
    planPath,
    name: explicitName || generatedName || "Next session",
    dryRun,
  };
}

export function nextSessionPrompt(planPath: string): string {
  return [
    `Execute the project plan at ${planPath} end to end.`,
    "Begin by reading the applicable project instructions and the complete plan.",
    "Preserve dirty work and existing working behavior.",
    "Continue autonomously through implementation and verification; stop only at completion or a genuinely mandatory human gate defined by the plan.",
    "Treat telemetry as observational only.",
  ].join(" ");
}
