import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  applyCacheAdapter,
  buildLlmDoneStepEvent,
  buildLlmTurnRequest,
  buildLlmTurnRequestForBinding,
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

  it('maps Moonshot/Kimi top-level usage.cached_tokens', () => {
    const stats = parseCacheUsage(
      {
        prompt_tokens: 19,
        completion_tokens: 21,
        total_tokens: 40,
        cached_tokens: 10,
      },
      'kimi-main',
    );
    assert.equal(stats?.cached_tokens, 10);
    assert.equal(stats?.prompt_tokens, 19);
    assert.equal(stats?.provider, 'kimi-main');
  });

  it('prefers prompt_tokens_details.cached_tokens over root', () => {
    const stats = parseCacheUsage({
      cached_tokens: 1,
      prompt_tokens_details: { cached_tokens: 99 },
    });
    assert.equal(stats?.cached_tokens, 99);
  });

  it('returns undefined when no cache signals', () => {
    assert.equal(parseCacheUsage({ prompt_tokens: 100 }), undefined);
    assert.equal(parseCacheUsage(null), undefined);
  });

  it('omits prompt_tokens-only usage without cache fields', () => {
    assert.equal(parseCacheUsage({ prompt_tokens: 500, completion_tokens: 12 }), undefined);
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

  it('injects prompt_cache_key for Moonshot sticky mode', () => {
    const result = applyCacheAdapter(
      messages,
      { mode: 'prompt_cache_key', session_id_from: 'session_id' },
      { sessionId: 'sess-kimi' },
    );
    assert.deepEqual(result.extraBody, { prompt_cache_key: 'sess-kimi' });
    assert.equal(result.messages, messages);
  });
});

describe('buildLlmTurnRequest', () => {
  it('strips reasoning_content when binding.preserveReasoning is false', () => {
    const config: AgentConfig = {
      apiKey: 'k',
      baseUrl: 'https://a.example',
      model: 'm',
      maxTurns: 0,
      cwd: '/tmp',
      allowShell: false,
      allowWeb: false,
      llm: {
        profileName: 'kimi-main',
        baseUrl: 'https://a.example',
        apiKey: 'k',
        model: 'm',
        wire: 'openai_chat',
        available: true,
        preserveReasoning: true,
      },
    };
    const withCoT = [
      {
        role: 'assistant' as const,
        content: 'ok',
        reasoning_content: 'secret think',
      },
    ];
    const keep = buildLlmTurnRequestForBinding(
      config,
      {
        profileName: 'kimi-main',
        baseUrl: 'https://a.example',
        apiKey: 'k',
        model: 'm',
        wire: 'openai_chat',
        available: true,
        preserveReasoning: true,
      },
      withCoT,
      { stream: false },
    );
    assert.equal(keep.apiMessages[0]?.reasoning_content, 'secret think');

    const strip = buildLlmTurnRequestForBinding(
      config,
      {
        profileName: 'xai-test',
        baseUrl: 'https://b.example',
        apiKey: 'x',
        model: 'g',
        wire: 'openai_chat',
        available: true,
        preserveReasoning: false,
      },
      withCoT,
      { stream: false },
    );
    assert.equal(strip.apiMessages[0]?.reasoning_content, undefined);
    assert.equal(strip.apiMessages[0]?.content, 'ok');
  });

  it('does not mix binding baseUrl with leftover config.apiKey', () => {
    const config: AgentConfig = {
      apiKey: 'sk-deepseek-LEFTOVER',
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-v4-flash',
      maxTurns: 0,
      cwd: '/tmp',
      allowShell: false,
      allowWeb: false,
      sessionId: 'sess',
      llm: {
        profileName: 'deepseek-main',
        baseUrl: 'https://api.deepseek.com',
        apiKey: 'sk-deepseek-LEFTOVER',
        model: 'deepseek-v4-flash',
        wire: 'openai_chat',
        available: true,
      },
    };

    const req = buildLlmTurnRequestForBinding(
      config,
      {
        profileName: 'kimi-main',
        baseUrl: 'https://api.moonshot.ai/v1',
        apiKey: 'sk-moonshot-CORRECT',
        model: 'kimi-k2.5',
        wire: 'openai_chat',
        available: true,
        apiKeyEnv: 'MOONSHOT_API_KEY',
      },
      [{ role: 'user', content: 'hi' }],
      { stream: false },
    );

    assert.equal(req.chatOpts.apiKey, 'sk-moonshot-CORRECT');
    assert.equal(req.chatOpts.baseUrl, 'https://api.moonshot.ai/v1');
    assert.equal(req.chatOpts.model, 'kimi-k2.5');
  });

  it('throws when binding has empty apiKey instead of falling back', () => {
    const config: AgentConfig = {
      apiKey: 'sk-deepseek-LEFTOVER',
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-v4-flash',
      maxTurns: 0,
      cwd: '/tmp',
      allowShell: false,
      allowWeb: false,
    };

    assert.throws(
      () =>
        buildLlmTurnRequestForBinding(
          config,
          {
            profileName: 'kimi-main',
            baseUrl: 'https://api.moonshot.ai/v1',
            apiKey: '',
            model: 'kimi-k2.5',
            wire: 'openai_chat',
            available: false,
            apiKeyEnv: 'MOONSHOT_API_KEY',
          },
          [{ role: 'user', content: 'hi' }],
          { stream: false },
        ),
      /empty API key.*MOONSHOT_API_KEY/,
    );
  });

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