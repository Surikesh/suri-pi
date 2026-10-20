import type { Data } from "../../../packages/protocol/src/index.js";

export const modelKey = (model: Data) => `${model.provider}/${model.id}`;
const normalize = (value: unknown) => String(value ?? "").toLocaleLowerCase();

export function searchModels(models: Data[], query: string, selected?: string) {
  const tokens = normalize(query).trim().split(/\s+/).filter(Boolean);
  const score = (model: Data) => {
    const id = normalize(model.id);
    const provider = normalize(model.provider);
    const fields = [id, provider, normalize(model.name), `${provider}/${id}`];
    if (!tokens.length) return modelKey(model) === selected ? -1 : 3;
    let total = 0;
    for (const token of tokens) {
      let best = Infinity;
      for (const field of fields) {
        if (field === token) best = Math.min(best, 0);
        else if (field.startsWith(token)) best = Math.min(best, 1);
        else if (field.includes(token)) best = Math.min(best, 2);
        else {
          let index = 0;
          for (const letter of field) if (letter === token[index]) index++;
          if (index === token.length) best = Math.min(best, 3);
        }
      }
      if (!Number.isFinite(best)) return Infinity;
      total += best;
    }
    return total;
  };
  return models
    .map((model) => ({ model, score: score(model) }))
    .filter(({ score }) => Number.isFinite(score))
    .sort(
      (a, b) =>
        a.score - b.score || modelKey(a.model).localeCompare(modelKey(b.model)),
    )
    .map(({ model }) => model);
}

// Ephemeral, session-bound discovery. A failed request is never cached.
export class ModelCatalog {
  private entries = new Map<string, Data[]>();
  private pending = new Map<string, Promise<Data[]>>();
  private generations = new Map<string, number>();
  constructor(private readonly capacity = 3) {}
  get(key: string) {
    const value = this.entries.get(key);
    if (value) {
      this.entries.delete(key);
      this.entries.set(key, value);
    }
    return value;
  }
  invalidate(key: string) {
    this.generations.set(key, (this.generations.get(key) ?? 0) + 1);
    this.entries.delete(key);
    this.pending.delete(key);
  }
  clear() {
    for (const key of new Set([...this.entries.keys(), ...this.pending.keys()]))
      this.invalidate(key);
  }
  async load(key: string, fetch: () => Promise<Data[]>, refresh = false) {
    if (!refresh) {
      const cached = this.get(key);
      if (cached) return cached;
    }
    const inflight = this.pending.get(key);
    if (inflight) return inflight;
    const generation = this.generations.get(key) ?? 0;
    const request = fetch()
      .then((models) => {
        if ((this.generations.get(key) ?? 0) === generation) {
          this.entries.delete(key);
          this.entries.set(key, models);
          while (this.entries.size > this.capacity)
            this.entries.delete(this.entries.keys().next().value!);
        }
        return models;
      })
      .catch((error) => {
        if ((this.generations.get(key) ?? 0) === generation)
          this.invalidate(key);
        throw error;
      })
      .finally(() => {
        if (this.pending.get(key) === request) this.pending.delete(key);
      });
    this.pending.set(key, request);
    return request;
  }
}
