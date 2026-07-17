import type { ChatOptions } from './llm.js';
import { projectReasoningForApi } from './llm-reasoning-content.js';
import { buildSessionReasoningExtraBody } from './llm-reasoning.js';
import type { ResolvedLlmBinding } from './llm-profiles.js';
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
    const sessionId = resolveStickySessionId(cache ?? { mode: 'openrouter_sticky' }, ctx.sessionId);
    if (!sessionId) {
      return { messages };
    }
    return {
      messages,
      extraBody: { session_id: sessionId },
    };
  }

  if (mode === 'prompt_cache_key') {
    const sessionId = resolveStickySessionId(
      cache ?? { mode: 'prompt_cache_key' },
      ctx.sessionId,
    );
    if (!sessionId) {
      return { messages };
    }
    return {
      messages,
      extraBody: { prompt_cache_key: sessionId },
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

  // Moonshot/Kimi: top-level usage.cached_tokens (also some OpenAI-compat gateways).
  const rootCached = readFiniteNumber(root, 'cached_tokens');
  if (rootCached !== undefined) stats.cached_tokens = rootCached;

  const details = asRecord(root.prompt_tokens_details);
  if (details) {
    const cached = readFiniteNumber(details, 'cached_tokens');
    const write = readFiniteNumber(details, 'cache_write_tokens');
    // Prefer details when present (more specific than root).
    if (cached !== undefined) stats.cached_tokens = cached;
    if (write !== undefined) stats.cache_write_tokens = write;
  }

  const hasCacheSignal =
    stats.cached_tokens !== undefined ||
    stats.cache_miss_tokens !== undefined ||
    stats.cache_write_tokens !== undefined;

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
  return buildLlmTurnRequestForBinding(config, null, apiMessages, opts);
}

/** Build turn request from a specific binding (G3 profile fallback). */
export function buildLlmTurnRequestForBinding(
  config: AgentConfig,
  binding: ResolvedLlmBinding | null,
  apiMessages: ChatMessage[],
  opts: { stream: boolean; signal?: AbortSignal },
): LlmTurnRequest {
  const cache = binding?.cache ?? config.llm?.cache;
  const profileExtra = binding?.extraBody ?? config.llm?.extraBody;

  const adapted = applyCacheAdapter(apiMessages, cache, {
    sessionId: config.sessionId,
  });
  // Re-project reasoning per binding (main may preserve CoT; fallback xAI-like APIs reject it).
  const preserveReasoning =
    binding != null
      ? Boolean(binding.preserveReasoning)
      : Boolean(config.llm?.preserveReasoning);
  const messagesForBinding = adapted.messages.map((m) =>
    projectReasoningForApi(m, preserveReasoning),
  );
  const reasoningExtra = binding
    ? buildSessionReasoningExtraBody(binding, config.sessionReasoningLevel)
    : buildSessionReasoningExtraBody(
        {
          reasoningMap: config.llm?.reasoningMap,
        },
        config.sessionReasoningLevel,
      );
  const extraBody = mergeExtraBody(profileExtra, adapted.extraBody, reasoningExtra);

  // When a binding is present, use its credentials as a unit — never mix
  // binding.baseUrl with a leftover config.apiKey from another profile.
  const apiKey = binding ? binding.apiKey : config.apiKey;
  const baseUrl = binding ? binding.baseUrl : config.baseUrl;
  const model = binding ? binding.model : config.model;
  if (binding && !apiKey?.trim()) {
    const envHint = binding.apiKeyEnv
      ? ` (set ${binding.apiKeyEnv} in .env)`
      : '';
    throw new Error(
      `LLM profile "${binding.profileName}" has empty API key${envHint}`,
    );
  }

  return {
    apiMessages: messagesForBinding,
    chatOpts: {
      apiKey,
      baseUrl,
      model,
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
  usage?: Record<string, unknown>;
  cache?: LlmCacheStats;
} {
  const event: {
    type: 'llm_done';
    turn: number;
    finishReason: string | null;
    usage?: Record<string, unknown>;
    cache?: LlmCacheStats;
  } = {
    type: 'llm_done',
    turn,
    finishReason,
  };

  if (usage && typeof usage === 'object' && !Array.isArray(usage)) {
    event.usage = usage as Record<string, unknown>;
  }

  if (shouldReportCacheStats(config.llm?.cache)) {
    const cache = parseCacheUsage(usage, config.llm?.profileName);
    if (cache) event.cache = cache;
  }

  return event;
}