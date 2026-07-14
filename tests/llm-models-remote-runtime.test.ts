import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';

import { clearRemoteModelsCacheForTests } from '../src/llm-models-remote.js';
import { AgentRuntime } from '../src/runner.js';

const ENV_KEYS = ['OPENAI_API_KEY', 'DEEPSEEK_API_KEY', 'ZAI_API_KEY', 'OPENROUTER_API_KEY', 'REMOTE_MODELS'] as const;

function snapshotEnv(): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const key of ENV_KEYS) {
    out[key] = process.env[key];
  }
  return out;
}

function restoreEnv(saved: Record<string, string | undefined>): void {
  for (const key of ENV_KEYS) {
    const value = saved[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

describe('AgentRuntime.listSessionModelChoicesAsync (G2-d)', () => {
  let savedEnv = snapshotEnv();
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    restoreEnv(savedEnv);
    savedEnv = snapshotEnv();
    globalThis.fetch = originalFetch;
    clearRemoteModelsCacheForTests();
  });

  /** Isolate from host shell (e.g. REMOTE_MODELS=0 in .env / profile). */
  function prepareRemoteModelsTestEnv(): void {
    process.env.OPENROUTER_API_KEY = 'or-key';
    delete process.env.OPENAI_API_KEY;
    // Must allow remote merge path; host may set REMOTE_MODELS=0.
    delete process.env.REMOTE_MODELS;
  }

  it('matches static list when remote fetch fails', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ma-remote-models-fail-'));
    writeFileSync(
      join(dir, 'agent.json'),
      JSON.stringify({
        default_api_profile: 'or-main',
        api_profiles: {
          'or-main': {
            base_url: 'https://openrouter.ai/api/v1',
            api_key_env: 'OPENROUTER_API_KEY',
            default_model: 'x-ai/grok-4.5',
            models: ['x-ai/grok-4.5'],
          },
        },
      }),
    );

    prepareRemoteModelsTestEnv();

    globalThis.fetch = (async () => new Response('down', { status: 503 })) as typeof fetch;

    const runtime = new AgentRuntime({ cwd: dir, deferSession: true });
    runtime.newSession();

    const staticChoices = runtime.listSessionModelChoices();
    const asyncList = await runtime.listSessionModelChoicesAsync();

    assert.deepEqual(
      asyncList.choices.map((c) => c.model),
      staticChoices.map((c) => c.model),
    );
    assert.equal(asyncList.source, 'static');
    assert.equal(asyncList.remoteError, '(fetch failed)');
  });

  it('enriches list from GET /models and uses merged length for shortcut', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ma-remote-models-ok-'));
    writeFileSync(
      join(dir, 'agent.json'),
      JSON.stringify({
        default_api_profile: 'or-main',
        api_profiles: {
          'or-main': {
            base_url: 'https://openrouter.ai/api/v1',
            api_key_env: 'OPENROUTER_API_KEY',
            default_model: 'x-ai/grok-4.5',
            models: ['x-ai/grok-4.5'],
          },
        },
      }),
    );

    prepareRemoteModelsTestEnv();

    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/models')) {
        return new Response(
          JSON.stringify({
            data: [{ id: 'x-ai/grok-4.5' }, { id: 'deepseek/deepseek-v4-flash' }],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response('not found', { status: 404 });
    }) as typeof fetch;

    const runtime = new AgentRuntime({ cwd: dir, deferSession: true });
    runtime.newSession();

    const asyncList = await runtime.listSessionModelChoicesAsync();
    assert.equal(asyncList.source, 'static+remote');
    assert.deepEqual(asyncList.choices.map((c) => c.model), [
      'x-ai/grok-4.5',
      'deepseek/deepseek-v4-flash',
    ]);
    assert.equal(asyncList.choices.length, 2);
  });

  it('discards stale remote result after profile change', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ma-remote-models-race-'));
    writeFileSync(
      join(dir, 'agent.json'),
      JSON.stringify({
        default_api_profile: 'deepseek-main',
        api_profiles: {
          'deepseek-main': {
            base_url: 'https://api.deepseek.com',
            api_key_env: 'DEEPSEEK_API_KEY',
            default_model: 'deepseek-v4-flash',
            models: ['deepseek-v4-flash', 'deepseek-v4-pro'],
          },
          'glm-main': {
            base_url: 'https://open.bigmodel.cn/api/paas/v4',
            api_key_env: 'ZAI_API_KEY',
            default_model: 'glm-5.2',
            models: ['glm-5.2'],
          },
        },
      }),
    );

    process.env.DEEPSEEK_API_KEY = 'ds-key';
    process.env.ZAI_API_KEY = 'glm-key';
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.OPENAI_API_KEY;

    let releaseFetch!: () => void;
    const fetchGate = new Promise<void>((resolve) => {
      releaseFetch = resolve;
    });

    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('api.deepseek.com/models')) {
        await fetchGate;
        return new Response(
          JSON.stringify({ data: [{ id: 'stale/should-not-appear' }] }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return new Response('not found', { status: 404 });
    }) as typeof fetch;

    const runtime = new AgentRuntime({ cwd: dir, deferSession: true });
    runtime.newSession();

    const pending = runtime.listSessionModelChoicesAsync();
    runtime.setSessionLlmProfile('glm-main');
    releaseFetch();
    const result = await pending;

    assert.deepEqual(result.choices.map((c) => c.model), ['glm-5.2']);
    assert.equal(result.source, 'static');
  });
});