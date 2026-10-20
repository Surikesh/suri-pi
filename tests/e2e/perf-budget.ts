// Wall-clock budgets are tuned for a developer machine. Slower runners (for
// example GitHub-hosted macOS) set SURI_E2E_PERF_SCALE to multiply them.
const requested = Number(process.env.SURI_E2E_PERF_SCALE);
const scale = Number.isFinite(requested) && requested >= 1 ? requested : 1;

export function perfBudget(ms: number): number {
  return ms * scale;
}
