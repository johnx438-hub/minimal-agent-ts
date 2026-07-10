import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { LlmHttpError } from '../src/llm-retry.js';
import {
  invokeLlmTurnWithFallback,
  isProfileFallbackEligible,
} from '../src/llm-fallback.js';
import { resolveLlmBindingChain } from '../src/llm-profiles.js';
import type { AgentConfig } from '../src/types.js';
import type { AgentPluginConfig } from '../src/plugins/types.js';
import type { AgentStepEvent } from '../src/events.js';

const DEEPSEEK_PROFILE = {
  base_url: 'https://api.deepseek.com',
  api_key_env: 'DEEPSEEK_API_KEY',
  default_model: 'deepseek-v4-flash',
};

const GLM_PROFILE = {
  base_url: 'https://open.bigmodel.cn/api/paas/v4',
  api_key_env: 'ZAI_API_KEY',
  default_model: 'glm-5.2',
};

function makeConfig(pluginConfig: AgentPluginConfig): AgentConfig {
  const chain = resolveLlmBindingChain(pluginConfig, {
    profileName: 'deepseek-main',
    env: { DEEPSEEK_API_KEY: 'ds-key', ZAI_API_KEY: 'glm-key' },
  });
  const primary = chain[0]!;
  const fallback = chain[1]!;
  return {
    apiKey: primary.apiKey,
    baseUrl: primary.baseUrl,
    model: primary.model,
    cwd: '/tmp',
    llm: {
      profileName: primary.profileName,
      baseUrl: primary.baseUrl,
      apiKey: primary.apiKey,
      model: primary.model,
      wire: 'openai_chat',
      available: true,
    },
    llmBindingChain: chain,
    llmProfileFallbackEnabled: true,
    llmPluginConfig: pluginConfig,
    _fallbackBaseUrl: fallback.baseUrl,
  } as AgentConfig & { _fallbackBaseUrl: string };
}

function okCompletion(): string {
  return JSON.stringify({
    choices: [
      {
        message: { role: 'assistant', content: 'ok' },
        finish_reason: 'stop',
      },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 1 },
  });
}

describe('isProfileFallbackEligible (G3 conservative)', () => {
  it('allows 503 before tokens', () => {
    assert.equal(isProfileFallbackEligible(new LlmHttpError(503, 'down'), false), true);
  });

  it('rejects 401', () => {
    assert.equal(isProfileFallbackEligible(new LlmHttpError(401, 'nope'), false), false);
  });

  it('rejects after partial stream', () => {
    assert.equal(isProfileFallbackEligible(new LlmHttpError(503, 'down'), true), false);
  });
});

describe('invokeLlmTurnWithFallback (G3-b)', () => {
  const originalFetch = globalThis.fetch;
  let savedFallback = process.env.FALLBACK;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (savedFallback === undefined) {
      delete process.env.FALLBACK;
    } else {
      process.env.FALLBACK = savedFallback;
    }
    savedFallback = process.env.FALLBACK;
  });

  it('falls back after primary exhausts HTTP retries', async () => {
    const pluginConfig: AgentPluginConfig = {
      builtin_tools: ['read_file'],
      api_profiles: {
        'deepseek-main': {
          ...DEEPSEEK_PROFILE,
          fallback_profiles: ['glm-main'],
        },
        'glm-main': GLM_PROFILE,
      },
    };
    const config = makeConfig(pluginConfig);
    const fallbackHost = config._fallbackBaseUrl;

    let primaryCalls = 0;
    let fallbackCalls = 0;

    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('https://api.deepseek.com')) {
        primaryCalls++;
        return new Response('unavailable', { status: 503 });
      }
      if (url.startsWith(fallbackHost)) {
        fallbackCalls++;
        return new Response(okCompletion(), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response('not found', { status: 404 });
    }) as typeof fetch;

    const events: AgentStepEvent[] = [];
    const result = await invokeLlmTurnWithFallback({
      turn: 1,
      config,
      apiMessages: [{ role: 'user', content: 'hi' }],
      tools: [],
      stream: false,
      onStep: (e) => events.push(e),
    });

    assert.equal(result.message.content, 'ok');
    assert.equal(primaryCalls, 3);
    assert.equal(fallbackCalls, 1);
    assert.equal(events.some((e) => e.type === 'llm_fallback'), true);
    assert.equal(events.filter((e) => e.type === 'llm_retry').length, 2);
  });

  it('does not fallback when explicit model override disables chain', async () => {
    const pluginConfig: AgentPluginConfig = {
      builtin_tools: ['read_file'],
      api_profiles: {
        'deepseek-main': {
          ...DEEPSEEK_PROFILE,
          fallback_profiles: ['glm-main'],
        },
        'glm-main': GLM_PROFILE,
      },
    };
    const config = makeConfig(pluginConfig);
    config.llmProfileFallbackEnabled = false;

    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return new Response('unavailable', { status: 503 });
    }) as typeof fetch;

    await assert.rejects(
      () =>
        invokeLlmTurnWithFallback({
          turn: 1,
          config,
          apiMessages: [{ role: 'user', content: 'hi' }],
          tools: [],
          stream: false,
        }),
      (err: unknown) => err instanceof LlmHttpError && err.status === 503,
    );

    assert.equal(calls, 3);
  });

  it('does not fallback on 401', async () => {
    const pluginConfig: AgentPluginConfig = {
      builtin_tools: ['read_file'],
      api_profiles: {
        'deepseek-main': {
          ...DEEPSEEK_PROFILE,
          fallback_profiles: ['glm-main'],
        },
        'glm-main': GLM_PROFILE,
      },
    };
    const config = makeConfig(pluginConfig);

    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return new Response('unauthorized', { status: 401 });
    }) as typeof fetch;

    await assert.rejects(
      () =>
        invokeLlmTurnWithFallback({
          turn: 1,
          config,
          apiMessages: [{ role: 'user', content: 'hi' }],
          tools: [],
          stream: false,
        }),
      (err: unknown) => err instanceof LlmHttpError && err.status === 401,
    );

    assert.equal(calls, 1);
  });
});