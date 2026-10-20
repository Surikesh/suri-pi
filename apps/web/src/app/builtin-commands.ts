export const builtinCommandNames = new Set([
  "settings",
  "model",
  "tree",
  "thinking",
  "scoped-models",
  "export",
  "import",
  "share",
  "copy",
  "name",
  "session",
  "changelog",
  "hotkeys",
  "fork",
  "clone",
  "trust",
  "login",
  "logout",
  "new",
  "next-session",
  "compact",
  "resume",
  "reload",
  "quit",
]);
export const builtinCommands = [...builtinCommandNames].map((name) => ({
  name,
  source: "builtin",
  description:
    name === "next-session"
      ? "Start a neighboring session from a workspace plan"
      : "Suri local command",
}));
