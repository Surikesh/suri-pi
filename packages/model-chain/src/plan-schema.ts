import { z } from "zod";

const provider = z.literal("openai-codex");
const thinking = z.enum([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);
const stageSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
  dependencies: z.array(z.string()).max(32),
  provider,
  modelId: z.string().min(1).max(160),
  thinking,
  instruction: z.string().min(1).max(20_000),
  ownedPaths: z.array(z.string().min(1).max(500)).max(100),
  acceptance: z.array(z.string().min(1).max(500)).min(1).max(20),
});
export const chainPlanSchema = z
  .object({
    schemaVersion: z.literal(1),
    requestId: z.uuid(),
    taskId: z.string().min(1).max(100),
    goal: z.string().min(1).max(4_000),
    workspace: z.string().min(1).max(4_096),
    adapter: z.enum(["herdr", "suri"]),
    stages: z.array(stageSchema).min(1).max(12),
  })
  .superRefine((plan, ctx) => {
    const ids = new Set<string>();
    for (const [index, stage] of plan.stages.entries()) {
      if (ids.has(stage.id))
        ctx.addIssue({
          code: "custom",
          path: ["stages", index, "id"],
          message: "duplicate stage id",
        });
      for (const dependency of stage.dependencies)
        if (!ids.has(dependency))
          ctx.addIssue({
            code: "custom",
            path: ["stages", index, "dependencies"],
            message: "dependency must precede stage",
          });
      for (const path of stage.ownedPaths)
        if (
          path.startsWith("/") ||
          path.split(/[\\/]/).some((part) => part === ".." || part === ".git")
        )
          ctx.addIssue({
            code: "custom",
            path: ["stages", index, "ownedPaths"],
            message: "unsafe owned path",
          });
      ids.add(stage.id);
    }
  });
