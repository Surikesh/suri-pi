import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const WEEK_SECONDS = 7 * 24 * 60 * 60;
const MIN_WEEK_SECONDS = 6 * 24 * 60 * 60;
const MAX_CREDENTIAL_BYTES = 32 * 1024;
const MAX_USAGE_RESPONSE_BYTES = 64 * 1024;

type CodexWeeklyUsage = {
  available: true;
  remainingPercent: number;
  usedPercent: number;
  windowSeconds: number;
  resetsAt?: string;
};

type CodexUsageResult =
  CodexWeeklyUsage | { available: false; reason: "unavailable" };

type UsageWindow = {
  used_percent?: unknown;
  limit_window_seconds?: unknown;
  reset_at?: unknown;
};

type UsagePayload = {
  rate_limit?: {
    primary_window?: UsageWindow;
    secondary_window?: UsageWindow;
  };
  additional_rate_limits?: Array<{
    rate_limit?: {
      primary_window?: UsageWindow;
      secondary_window?: UsageWindow;
    };
  }>;
};

type ReaderOptions = {
  fetch?: typeof globalThis.fetch;
  credential?: () => Promise<string>;
  now?: () => number;
};

function decodeJwtPayload(token: string): Record<string, unknown> {
  const payload = token.split(".")[1];
  if (!payload) throw Error("Invalid Codex credential.");
  return JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
}

function accountId(token: string): string {
  const claims = decodeJwtPayload(token);
  const auth = claims["https://api.openai.com/auth"];
  if (!auth || typeof auth !== "object") throw Error("Missing Codex account.");
  const id = (auth as Record<string, unknown>).chatgpt_account_id;
  if (typeof id !== "string" || !id) throw Error("Missing Codex account.");
  return id;
}

function windows(payload: UsagePayload): UsageWindow[] {
  const limits = [
    payload.rate_limit,
    ...(payload.additional_rate_limits ?? []).map((item) => item.rate_limit),
  ];
  return limits.flatMap((limit) =>
    limit
      ? [limit.primary_window, limit.secondary_window].filter(
          (window): window is UsageWindow => Boolean(window),
        )
      : [],
  );
}

async function boundedJson(response: Response): Promise<unknown> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_USAGE_RESPONSE_BYTES)
    throw Error("Codex usage response is too large.");
  if (!response.body) throw Error("Codex usage response is empty.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_USAGE_RESPONSE_BYTES)
        throw Error("Codex usage response is too large.");
      chunks.push(value);
    }
  } finally {
    // Best effort: a reader that already closed has nothing left to cancel.
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(bytes));
}

export function parseCodexWeeklyUsage(
  payload: unknown,
): CodexWeeklyUsage | undefined {
  if (!payload || typeof payload !== "object") return;
  const candidates = windows(payload as UsagePayload)
    .map((window) => ({
      window,
      seconds: Number(window.limit_window_seconds),
      used: Number(window.used_percent),
    }))
    .filter(
      (candidate) =>
        Number.isFinite(candidate.seconds) &&
        candidate.seconds >= MIN_WEEK_SECONDS &&
        Number.isFinite(candidate.used),
    )
    .sort(
      (a, b) =>
        Math.abs(a.seconds - WEEK_SECONDS) - Math.abs(b.seconds - WEEK_SECONDS),
    );
  const selected = candidates[0];
  if (!selected) return;
  const usedPercent = Math.min(100, Math.max(0, selected.used));
  const resetSeconds = Number(selected.window.reset_at);
  return {
    available: true,
    usedPercent,
    remainingPercent: 100 - usedPercent,
    windowSeconds: selected.seconds,
    ...(Number.isFinite(resetSeconds) && resetSeconds > 0
      ? { resetsAt: new Date(resetSeconds * 1000).toISOString() }
      : {}),
  };
}

export class CodexUsageReader {
  private cached?: { at: number; value: CodexUsageResult };

  constructor(
    private executable: string,
    private options: ReaderOptions = {},
  ) {}

  async read(): Promise<CodexUsageResult> {
    const now = (this.options.now ?? Date.now)();
    if (this.cached && now - this.cached.at < 60_000) return this.cached.value;
    try {
      const token = this.options.credential
        ? await this.options.credential()
        : (
            await execFileAsync(
              this.executable,
              ["auth", "print-bearer-token", "--provider", "openai-codex"],
              {
                encoding: "utf8",
                timeout: 10_000,
                maxBuffer: MAX_CREDENTIAL_BYTES,
              },
            )
          ).stdout.trim();
      if (!token || token.length > MAX_CREDENTIAL_BYTES)
        throw Error("Codex credential is unavailable.");
      const response = await (this.options.fetch ?? globalThis.fetch)(
        "https://chatgpt.com/backend-api/wham/usage",
        {
          headers: {
            Accept: "application/json",
            Authorization: `Bearer ${token}`,
            "ChatGPT-Account-Id": accountId(token),
          },
          signal: AbortSignal.timeout(10_000),
          redirect: "error",
          cache: "no-store",
        },
      );
      if (!response.ok) throw Error("Codex usage request failed.");
      const value =
        parseCodexWeeklyUsage(await boundedJson(response)) ??
        ({ available: false, reason: "unavailable" } as const);
      this.cached = { at: now, value };
      return value;
    } catch {
      const value = { available: false, reason: "unavailable" } as const;
      this.cached = { at: now, value };
      return value;
    }
  }
}
