import type { AgentStepEvent } from './events.js';
import { buildLlmTurnRequestForBinding } from './llm-cache.js';
import {
  formatLlmRetryReason,
  isRetriableLlmError,
  DEFAULT_LLM_RETRY_CONFIG,
} from './llm-retry.js';
import {
  applyLlmBindingToAgentConfig,
  pickFirstAvailableBinding,
  resolveLlmBindingChain,
  type ResolveLlmBindingOptions,
  type ResolvedLlmBinding,
} from './llm-profiles.js';
import type { AgentPluginConfig } from './plugins/types.js';
import {
  invokeLlmTurn,
  LlmTurnFailedError,
  type LlmTurnOptions,
} from './stream-draft.js';
import type { AgentConfig, ChatMessage, ToolDefinition } from './types.js';
import type { LlmResult } from './llm.js';

/** Profile-chain fallback disabled when FALLBACK=0 or an explicit model override is set. */
export function isLlmProfileFallbackEnabled(explicitModel?: string): boolean {
  if (process.env.FALLBACK === '0') return false;
  if (explicitModel?.trim()) return false;
  return true;
}

/** Conservative: same retriable set as HTTP retry (429/5xx/network); no 401 fallback. */
export function isProfileFallbackEligible(err: unknown, tokensEmitted: boolean): boolean {
  return isRetriableLlmError(err, tokensEmitted);
}

export function availableBindingsInChain(
  chain: ResolvedLlmBinding[],
  fallbackEnabled: boolean,
): ResolvedLlmBinding[] {
  const available = chain.filter((b) => b.available);
  return fallbackEnabled ? available : available.slice(0, 1);
}

export function resolveLlmTurnBindings(config: AgentConfig): ResolvedLlmBinding[] {
  const chain = config.llmBindingChain;
  if (chain && chain.length > 0) {
    return availableBindingsInChain(chain, config.llmProfileFallbackEnabled !== false);
  }
  if (config.llm) {
    const binding: ResolvedLlmBinding = {
      profileName: config.llm.profileName,
      baseUrl: config.llm.baseUrl,
      apiKey: config.llm.apiKey,
      model: config.llm.model,
      wire: config.llm.wire,
      cache: config.llm.cache,
      extraBody: config.llm.extraBody,
      displayName: config.llm.displayName,
      fallbackProfiles: config.llm.fallbackProfiles,
      reasoningMap: config.llm.reasoningMap,
      available: config.llm.available,
      unavailableReason: config.llm.unavailableReason,
    };
    return availableBindingsInChain([binding], config.llmProfileFallbackEnabled !== false);
  }
  return [];
}

export interface LlmTurnWithFallbackOptions {
  turn: number;
  config: AgentConfig;
  apiMessages: ChatMessage[];
  tools: ToolDefinition[];
  stream: boolean;
  onStep?: (event: AgentStepEvent) => void;
}

/**
 * Run one LLM turn: HTTP retry within each profile, then optional profile-chain fallback (G3).
 */
export async function invokeLlmTurnWithFallback(
  opts: LlmTurnWithFallbackOptions,
): Promise<LlmResult> {
  const { turn, config, apiMessages, tools, stream, onStep } = opts;
  const bindings = resolveLlmTurnBindings(config);

  if (bindings.length === 0) {
    throw new Error('No available LLM profile in binding chain');
  }

  let lastError: unknown = new Error('invokeLlmTurnWithFallback: no attempt made');

  for (let i = 0; i < bindings.length; i++) {
    const binding = bindings[i]!;
    const llmTurn = buildLlmTurnRequestForBinding(config, binding, apiMessages, {
      stream,
      signal: config.abortSignal,
    });

    const turnOpts: LlmTurnOptions = {
      turn,
      apiMessages: llmTurn.apiMessages,
      tools,
      stream,
      onStep,
      chatOpts: llmTurn.chatOpts,
    };

    try {
      return await invokeLlmTurn(turnOpts);
    } catch (err) {
      const tokensEmitted = err instanceof LlmTurnFailedError ? err.tokensEmitted : false;
      const cause = err instanceof LlmTurnFailedError ? err.cause : err;
      lastError = cause;

      const hasNext = i < bindings.length - 1;
      if (
        !hasNext ||
        config.llmProfileFallbackEnabled === false ||
        !isProfileFallbackEligible(cause, tokensEmitted)
      ) {
        throw cause;
      }

      const next = bindings[i + 1]!;
      onStep?.({
        type: 'llm_fallback',
        turn,
        from_profile: binding.profileName,
        to_profile: next.profileName,
        from_model: binding.model,
        to_model: next.model,
        reason: formatLlmRetryReason(cause),
        attempt: DEFAULT_LLM_RETRY_CONFIG.maxAttempts,
      });
    }
  }

  throw lastError;
}

/** First available binding for pre-flight / run_start (effective profile). */
export function resolveEffectiveBindingFromChain(
  chain: ResolvedLlmBinding[],
): ResolvedLlmBinding {
  const effective = pickFirstAvailableBinding(chain);
  if (!effective) {
    throw new Error(
      `No available LLM profile in chain: ${chain.map((b) => b.profileName).join(' → ')}`,
    );
  }
  return effective;
}

/** Resolve chain, apply effective binding, and attach chain + fallback flag on config. */
export function configureAgentLlmBinding(
  config: AgentConfig,
  pluginConfig: AgentPluginConfig,
  opts: ResolveLlmBindingOptions = {},
): void {
  const chain = resolveLlmBindingChain(pluginConfig, opts);
  const effective = resolveEffectiveBindingFromChain(chain);
  applyLlmBindingToAgentConfig(config, effective);
  config.llmBindingChain = chain;
  config.llmProfileFallbackEnabled = isLlmProfileFallbackEnabled(opts.model);
}