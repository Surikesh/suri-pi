import { DurableChain } from "./index.js";
import { HerdrAdapter } from "./adapters.js";

const [root, requestId] = process.argv.slice(2);
if (!root || !requestId) process.exit(2);
const chain = new DurableChain(root);
try {
  const state = await chain.read(requestId);
  if (state.plan.adapter === "suri") {
    await chain.blockStartup(requestId, "SURI_CHAIN_CAPABILITY_UNAVAILABLE");
    process.exitCode = 3;
  } else {
    const adapter = new HerdrAdapter();
    const result = state.active
      ? await chain.reconcile(requestId, adapter)
      : await chain.step(requestId, adapter);
    if (result.status === "ready") await chain.step(requestId, adapter);
  }
} catch (error) {
  const code = error instanceof Error ? error.message : "RUNNER_START_FAILED";
  try {
    await chain.blockStartup(requestId, code);
  } catch {
    // The journal already crossed a terminal/non-retryable boundary.
  }
  process.exitCode = 3;
}
