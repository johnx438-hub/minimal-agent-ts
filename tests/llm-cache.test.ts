import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  applyCacheAdapter,
  buildLlmDoneStepEvent,
  buildLlmTurnRequest,
  parseCacheUsage,
} from '../src/llm-cache.js';
import { buildChatBody } from '../src/llm.js';
import type { AgentConfig } from '../src/types.js';

describe('parseCacheUsage', () => {
  it('maps DeepSeek prompt_cache_* fields', () => {
    const stats = parseCacheUsage(
      {
        prompt_tokens: 12000,
        prompt_cache_hit_tokens: 9800,
        prompt_cache_miss_tokens: 2200,
      },
      'deepseek-main',
    );

    assert.deepEqual(stats, {
      provider: 'deepseek-main',
      prompt_tokens: 12000,
      cached_tokens: 9800,
      cache_miss_tokens: 2200,
    });
  });

  it('maps GLM/xAI/OpenRouter prompt_tokens_details', () => {
    const stats = parseCacheUsage(
      {
        prompt_tokens: 5000,
        prompt_tokens_details: {
          cached_tokens: 4200,
          cache_write_tokens: 0,
        },
      },
      'glm-main',
    );

    assert.deepEqual(stats, {
      provider: 'glm-main',
      prompt_tokens: 5000,
      cached_tokens: 4200,
      cache_write_tokens: 0,
    });
  });

  it('returns undefined when no cache signals', () => {
    assert.equal(parseCacheUsage({ prompt_tokens: 100 }), undefined);
    assert.equal(parseCacheUsage(null), undefined);
  });
});

describe('applyCacheAdapter', () => {
  const messages = [{ role: 'user' as const, content: 'hi' }];

  it('leaves messages unchanged for implicit mode', () => {
    const result = applyCacheAdapter(messages, { mode: 'implicit' });
    assert.equal(result.messages, messages);
    assert.equal(result.extraBody, undefined);
  });

  it('injects session_id for openrouter_sticky', () => {
    const result = applyCacheAdapter(
      messages,
      { mode: 'openrouter_sticky', session_id_from: 'session_id' },
      { sessionId: 'sess-abc' },
    );

    assert.deepEqual(result.extraBody, { session_id: 'sess-abc' });
  });

  it('uses fixed session_id when configured', () => {
    const result = applyCacheAdapter(
      messages,
      {
        mode: 'openrouter_sticky',
        session_id_from: 'fixed',
        session_id: 'my-fixed-session',
      },
      { sessionId: 'ignored' },
    );

    assert.deepEqual(result.extraBody, { session_id: 'my-fixed-session' });
  });
});

describe('buildLlmTurnRequest', () => {
  it('merges profile extra_body and openrouter session_id', () => {
    const config: AgentConfig = {
      apiKey: 'key',
      baseUrl: 'https://openrouter.ai/api/v1',
      model: 'deepseek/deepseek-v4-flash',
      maxTurns: 0,
      cwd: '/tmp',
      allowShell: false,
      allowWeb: false,
      sessionId: 'session-42',
      llm: {
        profileName: 'openrouter-test',
        baseUrl: 'https://openrouter.ai/api/v1',
        apiKey: 'key',
        model: 'deepseek/deepseek-v4-flash',
        wire: 'openai_chat',
        available: true,
        cache: { mode: 'openrouter_sticky', session_id_from: 'session_id' },
        extraBody: { provider: { order: ['DeepSeek'] } },
      },
    };

    const req = buildLlmTurnRequest(
      config,
      [{ role: 'user', content: 'hello' }],
      { stream: true },
    );

    const body = buildChatBody(
      req.chatOpts.model,
      req.apiMessages,
      [],
      true,
      req.chatOpts.extraBody,
    );

    assert.equal(body.session_id, 'session-42');
    assert.deepEqual(body.provider, { order: ['DeepSeek'] });
  });
});

describe('buildLlmDoneStepEvent', () => {
  it('includes cache only when profile cache mode is enabled', () => {
    const config: AgentConfig = {
      apiKey: 'k',
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-v4-flash',
      maxTurns: 0,
      cwd: '/tmp',
      allowShell: false,
      allowWeb: false,
      llm: {
        profileName: 'deepseek-main',
        baseUrl: 'https://api.deepseek.com',
        apiKey: 'k',
        model: 'deepseek-v4-flash',
        wire: 'openai_chat',
        available: true,
        cache: { mode: 'implicit' },
      },
    };

    const withCache = buildLlmDoneStepEvent(2, 'tool_calls', {
      prompt_tokens: 900,
      prompt_cache_hit_tokens: 800,
      prompt_cache_miss_tokens: 100,
    }, config);

    assert.equal(withCache.cache?.cached_tokens, 800);
    assert.equal(withCache.cache?.provider, 'deepseek-main');

    const offConfig: AgentConfig = {
      ...config,
      llm: { ...config.llm!, cache: { mode: 'off' } },
    };
    const withoutCache = buildLlmDoneStepEvent(2, 'stop', {
      prompt_cache_hit_tokens: 800,
    }, offConfig);

    assert.equal(withoutCache.cache, undefined);
  });
});