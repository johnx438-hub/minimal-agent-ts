import { normalizeBaseUrl, type ResolvedLlmBinding } from './llm-profiles.js';

export type RemoteModelsFetchError = 'timeout' | 'auth' | 'not_found' | 'parse' | 'network';

export interface RemoteModelsFetchResult {
  ok: boolean;
  models: string[];
  error?: RemoteModelsFetchError;
}

export type MergedModelListSource = 'static' | 'static+remote';

export interface MergedModelListResult {
  models: string[];
  source: MergedModelListSource;
  remoteError?: string;
}

export const REMOTE_MODELS_CACHE_TTL_MS = 10 * 60 * 1000;
export const REMOTE_MODELS_FETCH_TIMEOUT_MS = 5000;
const DEFAULT_REMOTE_MODELS_MAX = 20;

interface CacheEntry {
  expiresAt: number;
  models: string[];
}

const remoteModelsCache = new Map<string, CacheEntry>();

export function isRemoteModelsEnabled(): boolean {
  return process.env.REMOTE_MODELS !== '0';
}

export function remoteModelsMaxAdditions(): number {
  const raw = process.env.REMOTE_MODELS_MAX?.trim();
  if (!raw) return DEFAULT_REMOTE_MODELS_MAX;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : DEFAULT_REMOTE_MODELS_MAX;
}

export function remoteModelsCacheKey(binding: ResolvedLlmBinding): string {
  return `${binding.profileName}:${normalizeBaseUrl(binding.baseUrl)}`;
}

export function clearRemoteModelsCacheForTests(): void {
  remoteModelsCache.clear();
}

/** Parse OpenAI-compatible GET /models JSON; returns null when shape is unrecognized. */
export function parseOpenAiModelsResponse(body: unknown): string[] | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return null;
  }

  const record = body as Record<string, unknown>;
  const data = record.data;
  if (Array.isArray(data)) {
    const ids: string[] = [];
    for (const item of data) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
      const id = (item as Record<string, unknown>).id;
      if (typeof id === 'string' && id.trim()) {
        ids.push(id.trim());
      }
    }
    return ids.length > 0 ? ids : [];
  }

  const models = record.models;
  if (Array.isArray(models)) {
    const ids: string[] = [];
    for (const item of models) {
      if (typeof item === 'string' && item.trim()) {
        ids.push(item.trim());
        continue;
      }
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
      const id = (item as Record<string, unknown>).id;
      if (typeof id === 'string' && id.trim()) {
        ids.push(id.trim());
      }
    }
    return ids.length > 0 ? ids : [];
  }

  return null;
}

/** Static models pinned first; remote adds new ids only, capped. */
export function mergeStaticAndRemoteModels(
  staticModels: string[],
  remoteModels: string[],
  maxRemoteAdditions: number = remoteModelsMaxAdditions(),
): string[] {
  const seen = new Set<string>();
  const merged: string[] = [];

  for (const model of staticModels) {
    const trimmed = model.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    merged.push(trimmed);
  }

  let added = 0;
  for (const model of remoteModels) {
    if (added >= maxRemoteAdditions) break;
    const trimmed = model.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    merged.push(trimmed);
    added++;
  }

  return merged;
}

export function formatRemoteModelsError(error: RemoteModelsFetchError): string {
  switch (error) {
    case 'auth':
      return '(auth failed)';
    case 'timeout':
      return '(fetch timeout)';
    case 'not_found':
      return '(models endpoint unavailable)';
    case 'parse':
      return '(fetch parse error)';
    default:
      return '(fetch failed)';
  }
}

function readCache(key: string): string[] | undefined {
  const entry = remoteModelsCache.get(key);
  if (!entry) return undefined;
  if (Date.now() >= entry.expiresAt) {
    remoteModelsCache.delete(key);
    return undefined;
  }
  return entry.models;
}

function writeCache(key: string, models: string[]): void {
  remoteModelsCache.set(key, {
    models,
    expiresAt: Date.now() + REMOTE_MODELS_CACHE_TTL_MS,
  });
}

export async function fetchRemoteModelIds(
  binding: ResolvedLlmBinding,
  opts: { signal?: AbortSignal; fetchFn?: typeof fetch } = {},
): Promise<RemoteModelsFetchResult> {
  const fetchFn = opts.fetchFn ?? globalThis.fetch;
  const url = `${normalizeBaseUrl(binding.baseUrl)}/models`;
  const timeoutSignal = AbortSignal.timeout(REMOTE_MODELS_FETCH_TIMEOUT_MS);
  const signal = opts.signal
    ? AbortSignal.any([opts.signal, timeoutSignal])
    : timeoutSignal;

  try {
    const res = await fetchFn(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${binding.apiKey}`,
        Accept: 'application/json',
      },
      signal,
    });

    if (res.status === 401 || res.status === 403) {
      return { ok: false, models: [], error: 'auth' };
    }
    if (res.status === 404) {
      return { ok: false, models: [], error: 'not_found' };
    }
    if (!res.ok) {
      return { ok: false, models: [], error: 'network' };
    }

    let body: unknown;
    try {
      body = await res.json();
    } catch {
      return { ok: false, models: [], error: 'parse' };
    }

    const parsed = parseOpenAiModelsResponse(body);
    if (parsed === null) {
      return { ok: false, models: [], error: 'parse' };
    }

    return { ok: true, models: parsed };
  } catch (err) {
    if (err instanceof Error && err.name === 'TimeoutError') {
      return { ok: false, models: [], error: 'timeout' };
    }
    if (err instanceof DOMException && err.name === 'AbortError') {
      return { ok: false, models: [], error: 'timeout' };
    }
    return { ok: false, models: [], error: 'network' };
  }
}

export async function resolveMergedModelIds(
  staticModels: string[],
  binding: ResolvedLlmBinding,
  opts: { fetchFn?: typeof fetch } = {},
): Promise<MergedModelListResult> {
  if (!isRemoteModelsEnabled() || !binding.available || !binding.apiKey.trim()) {
    return { models: [...staticModels], source: 'static' };
  }

  const cacheKey = remoteModelsCacheKey(binding);
  const cached = readCache(cacheKey);
  if (cached) {
    const baseCount = mergeStaticAndRemoteModels(staticModels, []).length;
    const merged = mergeStaticAndRemoteModels(staticModels, cached);
    return {
      models: merged,
      source: merged.length > baseCount ? 'static+remote' : 'static',
    };
  }

  const fetched = await fetchRemoteModelIds(binding, { fetchFn: opts.fetchFn });
  if (!fetched.ok) {
    return {
      models: [...staticModels],
      source: 'static',
      remoteError: fetched.error ? formatRemoteModelsError(fetched.error) : undefined,
    };
  }

  if (fetched.models.length > 0) {
    writeCache(cacheKey, fetched.models);
  }

  const baseCount = mergeStaticAndRemoteModels(staticModels, []).length;
  const merged = mergeStaticAndRemoteModels(staticModels, fetched.models);
  return {
    models: merged,
    source: merged.length > baseCount ? 'static+remote' : 'static',
  };
}