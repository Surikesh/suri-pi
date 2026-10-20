import { spawnSync } from "node:child_process";

export const portableChecks = [
  "format:portable",
  "lint",
  "typecheck",
  "build",
  "test:unit",
  "test:rpc",
  "test:integration",
  "test:e2e",
  "test:a11y",
];

if (process.argv.includes("--list")) {
  process.stdout.write(portableChecks.join("\n") + "\n");
  process.exit(0);
}

for (const check of portableChecks) {
  const result = spawnSync("npm", ["run", check], {
    stdio: "inherit",
    env: process.env,
  });
  if (result.error) {
    console.error(`Portable verification could not start ${check}.`);
    process.exit(1);
  }
  if (result.status !== 0) process.exit(result.status ?? 1);
}
