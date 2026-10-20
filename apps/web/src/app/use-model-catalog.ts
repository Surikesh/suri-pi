import { useEffect, useRef, useState } from "react";
import {
  type Data,
  type initialProjection,
} from "../../../../packages/protocol/src/index.js";
import { command, store, type State } from "../store.js";
import { ModelCatalog } from "../model-search.js";

export function useModelCatalog({
  state,
  session,
}: {
  state: State;
  session: Data | undefined;
}) {
  const catalog = useRef(new ModelCatalog());
  const discovery = useRef(new Map<string, Promise<Data[]>>());
  const catalogSources = useRef(
    new Map<string, { key: string; signature: string }>(),
  );
  const catalogGeneration = useRef(0);
  const [models, setModels] = useState<Data[]>([]);
  const [prefetchFailure, setPrefetchFailure] = useState<{
    identity: string;
    message: string;
  }>();
  useEffect(() => {
    if (!state.connected) {
      catalogGeneration.current++;
      catalog.current.clear();
      discovery.current.clear();
      setModels([]);
    }
  }, [state.connected, state.hostEpoch]);
  const catalogKey = (target: Data) =>
    `${target.id}:${target.workspaceId}:${target.runtimeId ?? target.runtime ?? ""}`;
  const sourceSignature = (target: Data, runtimes: Data[]) =>
    `${catalogKey(target)}:${JSON.stringify(runtimes.find((runtime) => runtime.id === target.runtimeId) ?? null)}`;
  // Revisions change on ordinary edits. Only the model source changes the cache.
  const catalogIdentity = `${state.selected ?? ""}:${session ? sourceSignature(session, state.catalog.runtimes) : ""}:${state.hostEpoch ?? ""}:${state.connected}`;
  useEffect(() => {
    const next = new Map<string, { key: string; signature: string }>();
    for (const item of state.catalog.sessions) {
      const key = catalogKey(item);
      const signature = sourceSignature(item, state.catalog.runtimes);
      next.set(item.id, { key, signature });
      const previous = catalogSources.current.get(item.id);
      if (previous && previous.signature !== signature) {
        catalog.current.invalidate(previous.key);
        if (previous.key !== key) catalog.current.invalidate(key);
        discovery.current.delete(previous.key);
      }
    }
    for (const [id, previous] of catalogSources.current) {
      if (!next.has(id)) catalog.current.invalidate(previous.key);
    }
    catalogSources.current = next;
  }, [state.catalog.sessions, state.catalog.runtimes]);
  useEffect(() => {
    setModels(session ? (catalog.current.get(catalogKey(session)) ?? []) : []);
    setPrefetchFailure(undefined);
  }, [catalogIdentity]);
  return {
    catalog,
    discovery,
    catalogGeneration,
    models,
    setModels,
    prefetchFailure,
    setPrefetchFailure,
    catalogKey,
    sourceSignature,
    catalogIdentity,
  };
}

export function useModelDiscovery({
  state,
  session,
  running,
  projection,
  catalog,
  discovery,
  catalogGeneration,
  catalogKey,
  sourceSignature,
  catalogIdentity,
  prefetchFailure,
  setModels,
  setPrefetchFailure,
}: {
  state: State;
  session: Data | undefined;
  running: boolean;
  projection: ReturnType<typeof initialProjection>;
  catalog: ReturnType<typeof useModelCatalog>["catalog"];
  discovery: ReturnType<typeof useModelCatalog>["discovery"];
  catalogGeneration: ReturnType<typeof useModelCatalog>["catalogGeneration"];
  catalogKey: (target: Data) => string;
  sourceSignature: (target: Data, runtimes: Data[]) => string;
  catalogIdentity: string;
  prefetchFailure: ReturnType<typeof useModelCatalog>["prefetchFailure"];
  setModels: ReturnType<typeof useModelCatalog>["setModels"];
  setPrefetchFailure: ReturnType<typeof useModelCatalog>["setPrefetchFailure"];
}) {
  const loadModels = async (target: Data, reload = false) => {
    const generation = catalogGeneration.current;
    const epoch = state.hostEpoch;
    const source = sourceSignature(target, state.catalog.runtimes);
    const key = catalogKey(target);
    let pending = discovery.current.get(key);
    if (reload && !pending) catalog.current.invalidate(key);
    if (!pending) {
      pending = catalog.current.load(
        key,
        async () => {
          await command("session.resume", {}, target.id);
          return (await command("model.list", {}, target.id)).models ?? [];
        },
        reload,
      );
      discovery.current.set(key, pending);
      // The awaiting caller below reports discovery failure; this branch only clears the cache entry without an unhandled rejection.
      void pending
        .finally(() => {
          if (discovery.current.get(key) === pending)
            discovery.current.delete(key);
        })
        .catch(() => {});
    }
    const available = await pending;
    const snapshot = store.getSnapshot();
    const current = snapshot.catalog.sessions.find(
      (item: Data) => item.id === target.id,
    );
    if (
      catalogGeneration.current !== generation ||
      snapshot.hostEpoch !== epoch ||
      !snapshot.connected ||
      snapshot.selected !== target.id ||
      !current ||
      sourceSignature(current, snapshot.catalog.runtimes) !== source ||
      catalog.current.get(key) !== available
    ) {
      throw Error(
        "Model catalog changed. Reopen search to load current models.",
      );
    }
    setModels(available);
    setPrefetchFailure(undefined);
    return available;
  };
  // Start one session-bound discovery as soon as the selected session is ready.
  // This is background work: never delay navigation or retry failures in a loop.
  useEffect(() => {
    if (
      !state.ready ||
      !state.connected ||
      !session ||
      running ||
      // Wait for the session snapshot: the placeholder projection looks idle.
      !state.projections[session.id] ||
      // A failed or interrupted session is retried only by an explicit action.
      ["failed", "interrupted"].includes(projection.phase) ||
      catalog.current.get(catalogKey(session)) !== undefined ||
      prefetchFailure?.identity === catalogIdentity
    )
      return;
    const target = session;
    const identity = catalogIdentity;
    void loadModels(target).catch((cause) => {
      const snapshot = store.getSnapshot();
      const current = snapshot.catalog.sessions.find(
        (item: Data) => item.id === target.id,
      );
      const currentIdentity = `${snapshot.selected ?? ""}:${current ? sourceSignature(current, snapshot.catalog.runtimes) : ""}:${snapshot.hostEpoch ?? ""}:${snapshot.connected}`;
      if (snapshot.connected && currentIdentity === identity) {
        setPrefetchFailure({
          identity,
          message:
            (cause as Error).message ||
            "Model discovery failed. Retry to try again.",
        });
      }
    });
  }, [
    state.ready,
    catalogIdentity,
    running,
    projection.phase,
    !!state.projections[session?.id ?? ""],
  ]);
  return { loadModels };
}
