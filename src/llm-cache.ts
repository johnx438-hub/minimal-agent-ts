import type { ChatOptions } from './llm.js';
import type { CachePolicyConfig } from './plugins/types.js';
import type { AgentConfig, ChatMessage } from './types.js';

export interface LlmCacheStats {
  prompt_tokens?: number;
  cached_tokens?: number;
  cache_miss_tokens?: number;
  cache_write_tokens?: number;
  provider?: string;
}

export interface CacheAdapterContext {
  sessionId?: string;
}

export interface CacheAdapterResult {
  messages: ChatMessage[];
  extraBody?: Record<string, unknown>;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

function readFiniteNumber(obj: Record<string, unknown>, key: string): number | undefined {
  const value = obj[key];
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  return undefined;
}

function resolveStickySessionId(
  cache: CachePolicyConfig,
  sessionId?: string,
): string | undefined {
  if (cache.session_id_from === 'fixed') {
    const fixed = cache.session_id?.trim();
    return fixed || undefined;
  }
  const fromSession = sessionId?.trim();
  if (fromSession) return fromSession;
  const fallback = cache.session_id?.trim();
  return fallback || undefined;
}

/**
 * Prepare outbound messages + optional request body extras for cache policies.
 * implicit / off: no message mutation (G1-cache).
 */
export function applyCacheAdapter(
  messages: ChatMessage[],
  cache: CachePolicyConfig | undefined,
  ctx: CacheAdapterContext = {},
): CacheAdapterResult {
  const mode = cache?.mode ?? 'off';

  if (mode === 'off' || mode === 'implicit' || mode === 'anthropic_breakpoints') {
    return { messages };
  }

  if (mode === 'openrouter_sticky') {
    const sessionId = resolveStickySessionId(cache, ctx.sessionId);
    if (!sessionId) {
      return { messages };
    }
    return {
      messages,
      extraBody: { session_id: sessionId },
    };
  }

  return { messages };
}

/** Normalize vendor-specific usage.cache fields into LlmCacheStats. */
export function parseCacheUsage(
  usage: unknown,
  profileName?: string,
): LlmCacheStats | undefined {
  const root = asRecord(usage);
  if (!root) return undefined;

  const stats: LlmCacheStats = {};
  if (profileName) stats.provider = profileName;

  const promptTokens = readFiniteNumber(root, 'prompt_tokens');
  if (promptTokens !== undefined) stats.prompt_tokens = promptTokens;

  const deepseekHit = readFiniteNumber(root, 'prompt_cache_hit_tokens');
  const deepseekMiss = readFiniteNumber(root, 'prompt_cache_miss_tokens');
  if (deepseekHit !== undefined) stats.cached_tokens = deepseekHit;
  if (deepseekMiss !== undefined) stats.cache_miss_tokens = deepseekMiss;

  const details = asRecord(root.prompt_tokens_details);
  if (details) {
    const cached = readFiniteNumber(details, 'cached_tokens');
    const write = readFiniteNumber(details, 'cache_write_tokens');
    if (cached !== undefined) stats.cached_tokens = cached;
    if (write !== undefined) stats.cache_write_tokens = write;
  }

  const hasCacheSignal =
    stats.cached_tokens !== undefined ||
    stats.cache_miss_tokens !== undefined ||
    stats.cache_write_tokens !== undefined;

  if (!hasCacheSignal && stats.prompt_tokens === undefined) {
    return undefined;
  }

  if (!hasCacheSignal) {
    return undefined;
  }

  return stats;
}

export function shouldReportCacheStats(cache: CachePolicyConfig | undefined): boolean {
  const mode = cache?.mode ?? 'off';
  return mode !== 'off';
}

export function mergeExtraBody(
  ...parts: Array<Record<string, unknown> | undefined>
): Record<string, unknown> | undefined {
  const merged: Record<string, unknown> = {};
  for (const part of parts) {
    if (!part) continue;
    Object.assign(merged, part);
  }
  return Object.keys(merged).length > 0 ? merged : undefined;
}

export interface LlmTurnRequest {
  apiMessages: ChatMessage[];
  chatOpts: ChatOptions;
}

/** Apply cache adapter + merge profile/cache extra_body into ChatOptions. */
export function buildLlmTurnRequest(
  config: AgentConfig,
  apiMessages: ChatMessage[],
  opts: { stream: boolean; signal?: AbortSignal },
): LlmTurnRequest {
  const adapted = applyCacheAdapter(apiMessages, config.llm?.cache, {
    sessionId: config.sessionId,
  });
  const extraBody = mergeExtraBody(config.llm?.extraBody, adapted.extraBody);

  return {
    apiMessages: adapted.messages,
    chatOpts: {
      apiKey: config.apiKey,
      baseUrl: config.baseUrl,
      model: config.model,
      stream: opts.stream,
      signal: opts.signal,
      extraBody,
    },
  };
}

export function buildLlmDoneStepEvent(
  turn: number,
  finishReason: string | null,
  usage: unknown,
  config: AgentConfig,
): {
  type: 'llm_done';
  turn: number;
  finishReason: string | null;
  usage?: object;
  cache?: LlmCacheStats;
} {
  const event: {
    type: 'llm_done';
    turn: number;
    finishReason: string | null;
    usage?: object;
    cache?: LlmCacheStats;
  } = {
    type: 'llm_done',
    turn,
    finishReason,
  };

  if (usage && typeof usage === 'object') {
    event.usage = usage as object;
  }

  if (shouldReportCacheStats(config.llm?.cache)) {
    const cache = parseCacheUsage(usage, config.llm?.profileName);
    if (cache) event.cache = cache;
  }

  return event;
}