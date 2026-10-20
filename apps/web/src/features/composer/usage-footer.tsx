import React from "react";
import { type Data } from "../../../../../packages/protocol/src/index.js";
import { tokenCount } from "../../domain/presentation.js";

export function UsageFooter({
  session,
  contextAvailable,
  contextTokens,
  contextWindow,
  contextRemaining,
  contextPercent,
  contextLabel,
  detailedUsageAvailable,
  usageEntries,
  codexConfigured,
  codexUsageAvailable,
  codexRemainingPercent,
  codexUsageLabel,
  codexUsage,
}: {
  session: Data | undefined;
  contextAvailable: boolean;
  contextTokens: number;
  contextWindow: number;
  contextRemaining: number;
  contextPercent: number;
  contextLabel: string;
  detailedUsageAvailable: boolean;
  usageEntries: Array<{ key: string; label: string; value: number }>;
  codexConfigured: boolean;
  codexUsageAvailable: boolean;
  codexRemainingPercent: number;
  codexUsageLabel: string;
  codexUsage: Data;
}) {
  return (
    <div className="usage-footer">
      <div
        className={`context-usage ${contextAvailable ? "available" : "unavailable"}`}
        aria-label={
          contextAvailable
            ? `Context: ${contextTokens} of ${contextWindow} tokens used, ${contextRemaining} remaining, ${Math.round(contextPercent)} percent`
            : contextLabel
        }
      >
        <span
          className="context-track"
          role="progressbar"
          aria-label="Context window used"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={
            contextAvailable ? Math.round(contextPercent) : undefined
          }
        >
          <span
            className="context-fill"
            style={{
              width: `${contextAvailable ? Math.min(100, Math.max(0, contextPercent)) : 0}%`,
            }}
          />
        </span>
        <span className="context-label">{contextLabel}</span>
      </div>
      {session && detailedUsageAvailable && (
        <dl className="turn-usage available" aria-label="Latest response usage">
          {usageEntries.map((entry) => (
            <div
              className={entry.key === "cost" ? "usage-cost" : undefined}
              title={entry.label}
              key={entry.key}
            >
              <dt aria-label={entry.label}>
                {entry.key === "input"
                  ? "↑"
                  : entry.key === "output"
                    ? "↓"
                    : entry.label}
              </dt>
              <dd>
                {entry.key === "cost"
                  ? `$${entry.value.toFixed(4)}`
                  : tokenCount(entry.value)}
              </dd>
            </div>
          ))}
        </dl>
      )}
      {(codexConfigured || codexUsageAvailable) && (
        <div
          className={`codex-usage ${codexUsageAvailable ? "available" : "unavailable"} ${codexUsageAvailable && codexRemainingPercent <= 15 ? "low" : ""}`}
          aria-label={codexUsageLabel}
          title={
            codexUsageAvailable && codexUsage.resetsAt
              ? `Weekly Codex allowance resets ${new Date(codexUsage.resetsAt).toLocaleString()}`
              : undefined
          }
        >
          <span
            className="context-track"
            role="progressbar"
            aria-label="Weekly Codex allowance remaining"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={
              codexUsageAvailable
                ? Math.round(codexRemainingPercent)
                : undefined
            }
          >
            <span
              className="context-fill"
              style={{ width: `${codexRemainingPercent}%` }}
            />
          </span>
          <span className="context-label">{codexUsageLabel}</span>
        </div>
      )}
    </div>
  );
}
