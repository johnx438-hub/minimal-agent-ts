import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { configureAgentLlmBinding, isLlmProfileFallbackEnabled } from '../src/llm-fallback.js';
import {
  pickFirstAvailableBinding,
  resolveLlmBindingChain,
} from '../src/llm-profiles.js';
import type { AgentPluginConfig } from '../src/plugins/types.js';
import type { AgentConfig } from '../src/types.js';

const DEEPSEEK_PROFILE = {
  base_url: 'https://api.deepseek.com',
  api_key_env: 'DEEPSEEK_API_KEY',
  default_model: 'deepseek-v4-flash',
  models: ['deepseek-v4-flash'],
};

const GLM_PROFILE = {
  base_url: 'https://open.bigmodel.cn/api/paas/v4',
  api_key_env: 'ZAI_API_KEY',
  default_model: 'glm-5.2',
  models: ['glm-5.2'],
};

function basePluginConfig(overrides: Partial<AgentPluginConfig> = {}): AgentPluginConfig {
  return {
    builtin_tools: ['read_file'],
    ...overrides,
  };
}

describe('resolveLlmBindingChain (G3-a)', () => {
  it('returns primary only when no fallback_profiles', () => {
    const chain = resolveLlmBindingChain(
      basePluginConfig({
        default_api_profile: 'deepseek-main',
        api_profiles: { 'deepseek-main': DEEPSEEK_PROFILE },
      }),
      { env: { DEEPSEEK_API_KEY: 'ds-key' } },
    );

    assert.equal(chain.length, 1);
    assert.equal(chain[0]?.profileName, 'deepseek-main');
  });

  it('appends fallback profiles in order', () => {
    const chain = resolveLlmBindingChain(
      basePluginConfig({
        default_api_profile: 'deepseek-main',
        api_profiles: {
          'deepseek-main': {
            ...DEEPSEEK_PROFILE,
            fallback_profiles: ['glm-main', 'review-cheap'],
          },
          'glm-main': GLM_PROFILE,
          'review-cheap': {
            ...GLM_PROFILE,
            default_model: 'glm-4.7-flash',
          },
        },
      }),
      {
        profileName: 'deepseek-main',
        env: { DEEPSEEK_API_KEY: 'ds-key', ZAI_API_KEY: 'glm-key' },
      },
    );

    assert.deepEqual(
      chain.map((b) => b.profileName),
      ['deepseek-main', 'glm-main', 'review-cheap'],
    );
    assert.equal(chain[1]?.model, 'glm-5.2');
    assert.equal(chain[2]?.model, 'glm-4.7-flash');
  });

  it('dedupes duplicate fallback names', () => {
    const chain = resolveLlmBindingChain(
      basePluginConfig({
        api_profiles: {
          primary: {
            ...DEEPSEEK_PROFILE,
            fallback_profiles: ['glm-main', 'glm-main'],
          },
          'glm-main': GLM_PROFILE,
        },
      }),
      {
        profileName: 'primary',
        env: { DEEPSEEK_API_KEY: 'ds-key', ZAI_API_KEY: 'glm-key' },
      },
    );

    assert.deepEqual(chain.map((b) => b.profileName), ['primary', 'glm-main']);
  });

  it('does not pass model override to fallback entries', () => {
    const chain = resolveLlmBindingChain(
      basePluginConfig({
        api_profiles: {
          primary: {
            ...DEEPSEEK_PROFILE,
            fallback_profiles: ['glm-main'],
          },
          'glm-main': GLM_PROFILE,
        },
      }),
      {
        profileName: 'primary',
        model: 'deepseek-v4-pro',
        env: { DEEPSEEK_API_KEY: 'ds-key', ZAI_API_KEY: 'glm-key' },
      },
    );

    assert.equal(chain[0]?.model, 'deepseek-v4-pro');
    assert.equal(chain[1]?.model, 'glm-5.2');
  });
});

describe('pickFirstAvailableBinding (G3-a)', () => {
  it('skips unavailable primary when fallback has key', () => {
    const chain = resolveLlmBindingChain(
      basePluginConfig({
        default_api_profile: 'deepseek-main',
        api_profiles: {
          'deepseek-main': {
            ...DEEPSEEK_PROFILE,
            fallback_profiles: ['glm-main'],
          },
          'glm-main': GLM_PROFILE,
        },
      }),
      { env: { ZAI_API_KEY: 'glm-key' } },
    );

    const effective = pickFirstAvailableBinding(chain);
    assert.equal(effective?.profileName, 'glm-main');
  });
});

describe('configureAgentLlmBinding (G3-a)', () => {
  it('sets effective profile and chain on config', () => {
    const pluginConfig = basePluginConfig({
      default_api_profile: 'deepseek-main',
      api_profiles: {
        'deepseek-main': {
          ...DEEPSEEK_PROFILE,
          fallback_profiles: ['glm-main'],
        },
        'glm-main': GLM_PROFILE,
      },
    });

    const config = { apiKey: '', baseUrl: '', model: '', cwd: '/tmp' } as AgentConfig;
    configureAgentLlmBinding(config, pluginConfig, { env: { ZAI_API_KEY: 'glm-key' } });

    assert.equal(config.llm?.profileName, 'glm-main');
    assert.equal(config.llmBindingChain?.length, 2);
    assert.equal(config.llmProfileFallbackEnabled, true);
  });

  it('disables profile fallback when explicit model is set', () => {
    assert.equal(isLlmProfileFallbackEnabled('deepseek-v4-pro'), false);
    assert.equal(isLlmProfileFallbackEnabled(undefined), true);
  });

  it('records disabled reason on config when explicit model is set', () => {
    const pluginConfig = basePluginConfig({
      default_api_profile: 'deepseek-main',
      api_profiles: {
        'deepseek-main': {
          ...DEEPSEEK_PROFILE,
          fallback_profiles: ['glm-main'],
        },
        'glm-main': GLM_PROFILE,
      },
    });

    const config = { apiKey: '', baseUrl: '', model: '', cwd: '/tmp' } as AgentConfig;
    configureAgentLlmBinding(config, pluginConfig, {
      env: { DEEPSEEK_API_KEY: 'ds-key', ZAI_API_KEY: 'glm-key' },
      model: 'deepseek-v4-pro',
    });

    assert.equal(config.llmProfileFallbackEnabled, false);
    assert.equal(config.llmProfileFallbackDisabledReason, 'explicit_model');
    assert.equal(config.llm?.model, 'deepseek-v4-pro');
  });
});