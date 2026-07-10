import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';

import { buildAgentConfig } from '../src/runner.js';

const ENV_KEYS = [
  'OPENAI_API_KEY',
  'OPENROUTER_API_KEY',
  'OPENAI_BASE_URL',
  'MODEL',
] as const;

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

describe('buildAgentConfig llm integration', () => {
  let savedEnv = snapshotEnv();
  let tempDir = '';

  afterEach(() => {
    restoreEnv(savedEnv);
    savedEnv = snapshotEnv();
  });

  it('uses __env__ when agent.json has no api_profiles', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'ma-build-config-'));
    writeFileSync(
      join(tempDir, 'agent.json'),
      JSON.stringify({ builtin_tools: ['read_file'] }),
    );

    process.env.OPENROUTER_API_KEY = 'or-test-key';
    process.env.OPENAI_BASE_URL = 'https://openrouter.ai/api/v1';
    process.env.MODEL = 'deepseek/deepseek-v4-flash';

    const { config } = buildAgentConfig({ cwd: tempDir });

    assert.equal(config.llm?.profileName, '__env__');
    assert.equal(config.apiKey, 'or-test-key');
    assert.equal(config.baseUrl, 'https://openrouter.ai/api/v1');
    assert.equal(config.model, 'deepseek/deepseek-v4-flash');
    assert.ok(config.llmPluginConfig);
  });

  it('resolves default_api_profile from agent.json', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'ma-build-config-'));
    writeFileSync(
      join(tempDir, 'agent.json'),
      JSON.stringify({
        default_api_profile: 'glm-main',
        api_profiles: {
          'glm-main': {
            base_url: 'https://open.bigmodel.cn/api/paas/v4',
            api_key_env: 'ZAI_API_KEY',
            default_model: 'glm-5.2',
          },
        },
      }),
    );

    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    process.env.ZAI_API_KEY = 'glm-secret';

    const { config } = buildAgentConfig({ cwd: tempDir });

    assert.equal(config.llm?.profileName, 'glm-main');
    assert.equal(config.apiKey, 'glm-secret');
    assert.equal(config.model, 'glm-5.2');
  });

  it('throws when resolved profile is unavailable', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'ma-build-config-'));
    writeFileSync(
      join(tempDir, 'agent.json'),
      JSON.stringify({
        default_api_profile: 'deepseek-main',
        api_profiles: {
          'deepseek-main': {
            base_url: 'https://api.deepseek.com',
            api_key_env: 'DEEPSEEK_API_KEY',
            default_model: 'deepseek-v4-flash',
          },
        },
      }),
    );

    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.DEEPSEEK_API_KEY;

    assert.throws(
      () => buildAgentConfig({ cwd: tempDir }),
      /No available LLM profile in chain: deepseek-main/,
    );
  });

  it('uses first available profile in fallback chain at startup (G3)', () => {
    tempDir = mkdtempSync(join(tmpdir(), 'ma-build-config-fallback-'));
    writeFileSync(
      join(tempDir, 'agent.json'),
      JSON.stringify({
        default_api_profile: 'deepseek-main',
        api_profiles: {
          'deepseek-main': {
            base_url: 'https://api.deepseek.com',
            api_key_env: 'DEEPSEEK_API_KEY',
            default_model: 'deepseek-v4-flash',
            fallback_profiles: ['glm-main'],
          },
          'glm-main': {
            base_url: 'https://open.bigmodel.cn/api/paas/v4',
            api_key_env: 'ZAI_API_KEY',
            default_model: 'glm-5.2',
          },
        },
      }),
    );

    delete process.env.DEEPSEEK_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    process.env.ZAI_API_KEY = 'glm-key';

    const { config } = buildAgentConfig({ cwd: tempDir });

    assert.equal(config.llm?.profileName, 'glm-main');
    assert.equal(config.llmBindingChain?.length, 2);
    assert.equal(config.llmProfileFallbackEnabled, true);
  });
});