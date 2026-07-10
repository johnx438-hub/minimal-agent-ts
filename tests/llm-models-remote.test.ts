import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import {
  clearRemoteModelsCacheForTests,
  fetchRemoteModelIds,
  formatRemoteModelsError,
  mergeStaticAndRemoteModels,
  parseOpenAiModelsResponse,
  remoteModelsCacheKey,
  resolveMergedModelIds,
} from '../src/llm-models-remote.js';
import type { ResolvedLlmBinding } from '../src/llm-profiles.js';

const BINDING: ResolvedLlmBinding = {
  profileName: 'openrouter-test',
  baseUrl: 'https://openrouter.ai/api/v1',
  apiKey: 'or-key',
  model: 'x-ai/grok-4.5',
  wire: 'openai_chat',
  available: true,
};

describe('parseOpenAiModelsResponse', () => {
  it('parses data[].id', () => {
    assert.deepEqual(
      parseOpenAiModelsResponse({
        data: [{ id: 'deepseek/deepseek-v4-flash' }, { id: 'z-ai/glm-5.2' }],
      }),
      ['deepseek/deepseek-v4-flash', 'z-ai/glm-5.2'],
    );
  });

  it('parses models[] strings', () => {
    assert.deepEqual(parseOpenAiModelsResponse({ models: ['a', 'b'] }), ['a', 'b']);
  });

  it('returns null for unknown shape', () => {
    assert.equal(parseOpenAiModelsResponse({ items: [] }), null);
  });
});

describe('mergeStaticAndRemoteModels', () => {
  it('pins static first and dedupes', () => {
    assert.deepEqual(
      mergeStaticAndRemoteModels(
        ['deepseek-v4-flash', 'deepseek-v4-pro'],
        ['z-ai/glm-5.2', 'deepseek-v4-flash', 'x-ai/grok-4.5'],
        10,
      ),
      ['deepseek-v4-flash', 'deepseek-v4-pro', 'z-ai/glm-5.2', 'x-ai/grok-4.5'],
    );
  });

  it('caps remote additions', () => {
    const merged = mergeStaticAndRemoteModels(['a'], ['b', 'c', 'd'], 2);
    assert.deepEqual(merged, ['a', 'b', 'c']);
  });
});

describe('fetchRemoteModelIds', () => {
  afterEach(() => {
    clearRemoteModelsCacheForTests();
    delete process.env.REMOTE_MODELS;
  });

  it('maps 401 to auth error', async () => {
    const result = await fetchRemoteModelIds(BINDING, {
      fetchFn: (async () =>
        new Response('nope', { status: 401 })) as typeof fetch,
    });
    assert.equal(result.ok, false);
    assert.equal(result.error, 'auth');
  });

  it('maps 404 to not_found', async () => {
    const result = await fetchRemoteModelIds(BINDING, {
      fetchFn: (async () =>
        new Response('missing', { status: 404 })) as typeof fetch,
    });
    assert.equal(result.error, 'not_found');
  });

  it('parses successful response', async () => {
    const result = await fetchRemoteModelIds(BINDING, {
      fetchFn: (async () =>
        new Response(
          JSON.stringify({
            data: [{ id: 'x-ai/grok-4.5' }, { id: 'deepseek/deepseek-v4-flash' }],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )) as typeof fetch,
    });
    assert.equal(result.ok, true);
    assert.deepEqual(result.models, ['x-ai/grok-4.5', 'deepseek/deepseek-v4-flash']);
  });
});

describe('resolveMergedModelIds', () => {
  afterEach(() => {
    clearRemoteModelsCacheForTests();
    delete process.env.REMOTE_MODELS;
    delete process.env.REMOTE_MODELS_MAX;
  });

  it('returns static only when REMOTE_MODELS=0', async () => {
    process.env.REMOTE_MODELS = '0';
    const result = await resolveMergedModelIds(['deepseek-v4-flash'], BINDING, {
      fetchFn: (async () => {
        throw new Error('should not fetch');
      }) as typeof fetch,
    });
    assert.deepEqual(result.models, ['deepseek-v4-flash']);
    assert.equal(result.source, 'static');
  });

  it('merges remote additions on success', async () => {
    const result = await resolveMergedModelIds(['x-ai/grok-4.5'], BINDING, {
      fetchFn: (async () =>
        new Response(
          JSON.stringify({
            data: [
              { id: 'x-ai/grok-4.5' },
              { id: 'deepseek/deepseek-v4-flash' },
              { id: 'z-ai/glm-5.2' },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )) as typeof fetch,
    });
    assert.equal(result.source, 'static+remote');
    assert.deepEqual(result.models, [
      'x-ai/grok-4.5',
      'deepseek/deepseek-v4-flash',
      'z-ai/glm-5.2',
    ]);
  });

  it('falls back to static on fetch failure', async () => {
    const staticOnly = ['deepseek-v4-flash', 'deepseek-v4-pro'];
    const result = await resolveMergedModelIds(staticOnly, BINDING, {
      fetchFn: (async () => new Response('down', { status: 503 })) as typeof fetch,
    });
    assert.deepEqual(result.models, staticOnly);
    assert.equal(result.source, 'static');
    assert.equal(result.remoteError, formatRemoteModelsError('network'));
  });

  it('uses cache on second call', async () => {
    let calls = 0;
    const fetchFn = (async () => {
      calls++;
      return new Response(
        JSON.stringify({ data: [{ id: 'x-ai/grok-4.5' }, { id: 'extra/model' }] }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }) as typeof fetch;

    await resolveMergedModelIds(['x-ai/grok-4.5'], BINDING, { fetchFn });
    const second = await resolveMergedModelIds(['x-ai/grok-4.5'], BINDING, { fetchFn });

    assert.equal(calls, 1);
    assert.equal(second.source, 'static+remote');
    assert.ok(second.models.includes('extra/model'));
    assert.equal(remoteModelsCacheKey(BINDING), 'openrouter-test:https://openrouter.ai/api/v1');
  });
});