import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ENV_PROFILE_NAME,
  getEnvApiKey,
  listModelsForProfile,
  listProfileNames,
  LlmProfileError,
  normalizeBaseUrl,
  resolveDefaultProfileName,
  resolveLlmBinding,
  resolvePresetLlmBinding,
} from '../src/llm-profiles.js';
import type { AgentPluginConfig } from '../src/plugins/types.js';

const DEEPSEEK_PROFILE = {
  display_name: 'DeepSeek V4',
  base_url: 'https://api.deepseek.com/',
  api_key_env: 'DEEPSEEK_API_KEY',
  default_model: 'deepseek-v4-flash',
  models: ['deepseek-v4-flash', 'deepseek-v4-pro'],
  cache: { mode: 'implicit' as const },
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

describe('normalizeBaseUrl', () => {
  it('strips trailing slashes', () => {
    assert.equal(normalizeBaseUrl('https://api.deepseek.com///'), 'https://api.deepseek.com');
  });
});

describe('resolveLlmBinding env fallback', () => {
  it('resolves __env__ when no api_profiles', () => {
    const binding = resolveLlmBinding(basePluginConfig(), {
      env: {
        OPENROUTER_API_KEY: 'sk-or-test',
        OPENAI_BASE_URL: 'https://openrouter.ai/api/v1',
        MODEL: 'x-ai/grok-4.5',
      },
    });

    assert.equal(binding.profileName, ENV_PROFILE_NAME);
    assert.equal(binding.apiKey, 'sk-or-test');
    assert.equal(binding.baseUrl, 'https://openrouter.ai/api/v1');
    assert.equal(binding.model, 'x-ai/grok-4.5');
    assert.equal(binding.available, true);
    assert.equal(binding.cache?.mode, 'off');
  });

  it('marks __env__ unavailable when API key missing', () => {
    const binding = resolveLlmBinding(basePluginConfig(), { env: {} });

    assert.equal(binding.available, false);
    assert.equal(binding.apiKey, '');
    assert.match(binding.unavailableReason ?? '', /OPENAI_API_KEY|OPENROUTER_API_KEY/);
  });

  it('uses default base URL and model when env omits them', () => {
    const binding = resolveLlmBinding(basePluginConfig(), {
      env: { OPENAI_API_KEY: 'sk-test' },
    });

    assert.equal(binding.baseUrl, 'https://generativelanguage.googleapis.com/v1beta/openai');
    assert.equal(binding.model, 'gemini-2.0-flash');
  });
});

describe('resolveLlmBinding named profiles', () => {
  const pluginConfig = basePluginConfig({
    default_api_profile: 'deepseek-main',
    api_profiles: {
      'deepseek-main': DEEPSEEK_PROFILE,
      'glm-main': GLM_PROFILE,
    },
  });

  it('resolves default_api_profile', () => {
    const binding = resolveLlmBinding(pluginConfig, {
      env: { DEEPSEEK_API_KEY: 'ds-key' },
    });

    assert.equal(binding.profileName, 'deepseek-main');
    assert.equal(binding.baseUrl, 'https://api.deepseek.com');
    assert.equal(binding.model, 'deepseek-v4-flash');
    assert.equal(binding.cache?.mode, 'implicit');
    assert.equal(binding.available, true);
  });

  it('applies model override', () => {
    const binding = resolveLlmBinding(pluginConfig, {
      profileName: 'deepseek-main',
      model: 'deepseek-v4-pro',
      env: { DEEPSEEK_API_KEY: 'ds-key' },
    });

    assert.equal(binding.model, 'deepseek-v4-pro');
  });

  it('marks profile unavailable when api_key_env missing', () => {
    const binding = resolveLlmBinding(pluginConfig, {
      profileName: 'glm-main',
      env: {},
    });

    assert.equal(binding.available, false);
    assert.equal(binding.unavailableReason, 'Missing environment variable ZAI_API_KEY');
  });

  it('throws for unknown profile', () => {
    assert.throws(
      () =>
        resolveLlmBinding(pluginConfig, {
          profileName: 'missing',
          env: { DEEPSEEK_API_KEY: 'x' },
        }),
      LlmProfileError,
    );
  });

  it('throws when default_api_profile is missing from api_profiles', () => {
    assert.throws(
      () =>
        resolveDefaultProfileName(
          basePluginConfig({
            default_api_profile: 'nope',
            api_profiles: { 'deepseek-main': DEEPSEEK_PROFILE },
          }),
        ),
      LlmProfileError,
    );
  });

  it('uses first profile when default_api_profile omitted', () => {
    const name = resolveDefaultProfileName(
      basePluginConfig({
        api_profiles: {
          'aaa-first': DEEPSEEK_PROFILE,
          'bbb-second': GLM_PROFILE,
        },
      }),
    );
    assert.equal(name, 'aaa-first');
  });

  it('passes extra_body and fallback_profiles through', () => {
    const binding = resolveLlmBinding(
      basePluginConfig({
        api_profiles: {
          or: {
            ...DEEPSEEK_PROFILE,
            api_key_env: 'OPENROUTER_API_KEY',
            extra_body: { provider: { order: ['DeepSeek'] } },
            fallback_profiles: ['glm-main'],
          },
          'glm-main': GLM_PROFILE,
        },
      }),
      {
        profileName: 'or',
        env: { OPENROUTER_API_KEY: 'or-key' },
      },
    );

    assert.deepEqual(binding.extraBody, { provider: { order: ['DeepSeek'] } });
    assert.deepEqual(binding.fallbackProfiles, ['glm-main']);
  });
});

describe('resolvePresetLlmBinding', () => {
  it('uses preset api_profile and model', () => {
    const pluginConfig = basePluginConfig({
      default_api_profile: 'deepseek-main',
      api_profiles: {
        'deepseek-main': DEEPSEEK_PROFILE,
        'glm-main': GLM_PROFILE,
      },
      spawn_presets: [
        {
          name: 'code-review-bug',
          prompt_file: 'agents/code-review-bug.md',
          tools: ['read_file'],
          api_profile: 'glm-main',
          model: 'glm-4.7-flash',
        },
      ],
    });

    const parentLlm = resolveLlmBinding(pluginConfig, {
      profileName: 'deepseek-main',
      env: { DEEPSEEK_API_KEY: 'ds-key' },
    });

    const binding = resolvePresetLlmBinding(pluginConfig, 'code-review-bug', parentLlm, {
      env: { ZAI_API_KEY: 'glm-key' },
    });

    assert.equal(binding.profileName, 'glm-main');
    assert.equal(binding.model, 'glm-4.7-flash');
    assert.equal(binding.available, true);
  });

  it('inherits parent profile when preset omits api_profile', () => {
    const pluginConfig = basePluginConfig({
      api_profiles: { 'deepseek-main': DEEPSEEK_PROFILE },
      spawn_presets: [
        {
          name: 'web-researcher',
          prompt_file: 'agents/web-researcher.md',
          tools: ['web_fetch'],
        },
      ],
    });

    const parentLlm = resolveLlmBinding(pluginConfig, {
      profileName: 'deepseek-main',
      env: { DEEPSEEK_API_KEY: 'ds-key' },
    });

    const binding = resolvePresetLlmBinding(pluginConfig, 'web-researcher', parentLlm, {
      env: { DEEPSEEK_API_KEY: 'ds-key' },
    });

    assert.equal(binding.profileName, 'deepseek-main');
    assert.equal(binding.model, 'deepseek-v4-flash');
  });
});

describe('listProfileNames / listModelsForProfile', () => {
  it('lists configured profiles plus __env__ when env key present', () => {
    const names = listProfileNames(
      basePluginConfig({
        api_profiles: { 'deepseek-main': DEEPSEEK_PROFILE },
      }),
      { OPENAI_API_KEY: 'sk' },
    );

    assert.deepEqual(names, ['__env__', 'deepseek-main']);
  });

  it('lists static model catalog', () => {
    const models = listModelsForProfile(
      basePluginConfig({
        api_profiles: { 'deepseek-main': DEEPSEEK_PROFILE },
      }),
      'deepseek-main',
    );

    assert.deepEqual(models, ['deepseek-v4-flash', 'deepseek-v4-pro']);
  });
});

describe('validateApiProfiles', () => {
  it('rejects invalid cache mode at resolve time', () => {
    assert.throws(
      () =>
        resolveLlmBinding(
          basePluginConfig({
            api_profiles: {
              bad: {
                ...DEEPSEEK_PROFILE,
                cache: { mode: 'invalid' as 'off' },
              },
            },
          }),
          { profileName: 'bad', env: { DEEPSEEK_API_KEY: 'x' } },
        ),
      LlmProfileError,
    );
  });
});

describe('getEnvApiKey', () => {
  it('prefers OPENAI_API_KEY over OPENROUTER_API_KEY', () => {
    assert.equal(
      getEnvApiKey({ OPENAI_API_KEY: 'a', OPENROUTER_API_KEY: 'b' }),
      'a',
    );
  });
});