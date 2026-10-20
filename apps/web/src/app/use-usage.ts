import { useEffect, useState } from "react";
import {
  type Data,
  type initialProjection,
} from "../../../../packages/protocol/src/index.js";
import { command, type State } from "../store.js";
import { viewStorage as localStorage } from "../view-storage.js";
import {
  knownUsageEntries,
  latestKnownUsage,
  tokenCount,
} from "../domain/presentation.js";

export function useUsage({
  state,
  session,
  projection,
  setDraft,
}: {
  state: State;
  session: Data | undefined;
  projection: ReturnType<typeof initialProjection>;
  setDraft: (value: string) => void;
}) {
  const [contextStats, setContextStats] = useState<Data>();
  const [globalCodexUsage, setGlobalCodexUsage] = useState<Data>();
  const [contextStatsState, setContextStatsState] = useState<
    "idle" | "loading" | "ready" | "error"
  >("idle");
  const contextKey = session
    ? `${session.id}:${session.model?.provider ?? ""}:${session.model?.id ?? ""}`
    : "";
  const currentContextStats =
    contextStats?.contextKey === contextKey ? contextStats : undefined;
  const contextUsage =
    currentContextStats?.contextUsage ?? projection.usage.contextUsage;
  const reportedContextTokens = Number(contextUsage?.tokens);
  const contextWindow = Number(contextUsage?.contextWindow);
  const reportedContextPercent = Number(contextUsage?.percent);
  const historyValue = currentContextStats?.compactionHistory?.tokens;
  const historyTokens = Number(historyValue);
  const historyAvailable =
    typeof historyValue === "number" &&
    Number.isFinite(historyTokens) &&
    historyTokens > 0;
  const contextTokens = historyAvailable
    ? historyTokens
    : reportedContextTokens;
  const contextPercent = historyAvailable
    ? (historyTokens / contextWindow) * 100
    : reportedContextPercent;
  const contextAvailable =
    Number.isFinite(contextTokens) &&
    contextTokens >= 0 &&
    Number.isFinite(contextWindow) &&
    contextWindow > 0 &&
    Number.isFinite(contextPercent) &&
    (historyAvailable ||
      (contextUsage?.tokens !== null && contextUsage?.percent !== null));
  const contextRemaining = contextAvailable
    ? Math.max(0, contextWindow - contextTokens)
    : 0;
  const contextLabel = contextAvailable
    ? `Context: ${tokenCount(contextTokens)} / ${tokenCount(contextWindow)} · ${Math.round(contextPercent)}%`
    : contextStatsState === "loading"
      ? "Loading context…"
      : contextUsage?.contextWindow &&
          (contextUsage.tokens === null || contextUsage.percent === null)
        ? "Context refreshes after the next response"
        : !session
          ? "Select a session to see context"
          : !state.connected
            ? "Context reconnecting…"
            : contextStatsState === "error"
              ? "Context could not be loaded"
              : "Context not reported by Pi";
  const reportedTurnUsage = projection.usage ?? {};
  const savedTurnUsage = (() => {
    if (!session) return undefined;
    try {
      return JSON.parse(
        localStorage.getItem(`suri.lastUsage.${session.id}`) ?? "null",
      );
    } catch {
      return undefined;
    }
  })();
  const turnUsage = latestKnownUsage(reportedTurnUsage, savedTurnUsage);
  const usageNumber = (value: unknown) => {
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? number : undefined;
  };
  const inputTokens = usageNumber(turnUsage.input);
  const outputTokens = usageNumber(turnUsage.output);
  const cacheReadTokens = usageNumber(turnUsage.cacheRead);
  const cacheWriteTokens = usageNumber(turnUsage.cacheWrite);
  const turnCost = usageNumber(turnUsage.cost);
  const usageEntries = knownUsageEntries({
    input: inputTokens,
    output: outputTokens,
    cacheRead: cacheReadTokens,
    cacheWrite: cacheWriteTokens,
    cost: turnCost,
  });
  const detailedUsageAvailable = usageEntries.length > 0;
  useEffect(() => {
    if (
      !session ||
      knownUsageEntries(reportedTurnUsage).every((entry) => entry.value === 0)
    )
      return;
    localStorage.setItem(
      `suri.lastUsage.${session.id}`,
      JSON.stringify(reportedTurnUsage),
    );
  }, [session?.id, reportedTurnUsage]);
  const codexConfigured = state.catalog.sessions.some(
    (candidate: Data) => candidate.model?.provider === "openai-codex",
  );
  const codexUsage =
    globalCodexUsage?.available === true
      ? globalCodexUsage
      : (currentContextStats?.codexUsage ?? globalCodexUsage);
  const codexRemaining = Number(codexUsage?.remainingPercent);
  const codexUsageAvailable =
    codexUsage?.available === true && Number.isFinite(codexRemaining);
  const codexRemainingPercent = codexUsageAvailable
    ? Math.min(100, Math.max(0, codexRemaining))
    : 0;
  const codexUsageLabel = codexUsageAvailable
    ? `Codex week: ${Math.round(codexRemainingPercent)}% left`
    : contextStatsState === "loading"
      ? "Codex week: loading…"
      : "Codex week: unavailable";
  const latestCompactionNotice = projection.notices.findLast(
    (notice) => notice.code === "compaction_end",
  );
  useEffect(() => {
    if (!session || !latestCompactionNotice) return;
    const eventSeq = Number(latestCompactionNotice.eventSeq);
    if (Number.isFinite(eventSeq) && eventSeq > 0) {
      const handledKey = `suri.compactionHandled.${session.id}`;
      if (eventSeq <= Number(localStorage.getItem(handledKey) ?? 0)) return;
      localStorage.setItem(handledKey, String(eventSeq));
    } else {
      const legacyKey = `suri.compactionLegacyReconciled.${session.id}`;
      if (localStorage.getItem(legacyKey)) return;
      localStorage.setItem(legacyKey, "true");
    }
    const draftKey = `suri.draft.${session.id}`;
    const savedDraft = localStorage.getItem(draftKey) ?? "";
    if (!/^\/compact(?:\s.*)?$/.test(savedDraft.trim())) return;
    localStorage.setItem(draftKey, "");
    if (state.selected === session.id) setDraft("");
  }, [
    session?.id,
    latestCompactionNotice?.code,
    latestCompactionNotice?.eventSeq,
  ]);
  useEffect(() => {
    setContextStats(undefined);
    setContextStatsState("idle");
  }, [contextKey]);
  useEffect(() => {
    if (
      !session ||
      !state.connected ||
      state.catalog.runtimeMode === "simulated"
    )
      return;
    let current = true;
    let loading = false;
    const load = () => {
      if (loading) return;
      loading = true;
      setContextStatsState("loading");
      void command("session.context", {}, session.id)
        .then((stats) => {
          if (current) {
            setContextStats({ ...stats, contextKey });
            setContextStatsState("ready");
          }
        })
        .catch(() => {
          if (current) setContextStatsState("error");
        })
        .finally(() => {
          loading = false;
        });
    };
    load();
    // Context is host-cached, so refreshing an idle selected session is cheap.
    const timer = setInterval(load, 10_000);
    return () => {
      current = false;
      clearInterval(timer);
    };
  }, [contextKey, state.connected, state.catalog.runtimeMode]);
  useEffect(() => {
    if (!state.connected || state.catalog.runtimeMode === "simulated") return;
    let current = true;
    let loading = false;
    const load = () => {
      if (loading) return;
      loading = true;
      // Usage is optional display data; a failed load keeps the previous value and retries on the next interval.
      void command("usage.codex")
        .then((usage) => {
          if (current) setGlobalCodexUsage(usage);
        })
        .catch(() => undefined)
        .finally(() => {
          loading = false;
        });
    };
    load();
    const timer = setInterval(load, 60_000);
    return () => {
      current = false;
      clearInterval(timer);
    };
  }, [state.connected, state.catalog.runtimeMode]);
  return {
    contextWindow,
    contextTokens,
    contextPercent,
    contextAvailable,
    contextRemaining,
    contextLabel,
    usageEntries,
    detailedUsageAvailable,
    codexConfigured,
    codexUsage,
    codexUsageAvailable,
    codexRemainingPercent,
    codexUsageLabel,
  };
}
