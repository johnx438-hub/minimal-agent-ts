import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  applyLlmBindingToAgentConfig,
  resolvePresetLlmBinding,
} from '../src/llm-profiles.js';
import type { AgentPluginConfig } from '../src/plugins/types.js';
import type { AgentConfig } from '../src/types.js';

const DEEPSEEK = {
  base_url: 'https://api.deepseek.com',
  api_key_env: 'DEEPSEEK_API_KEY',
  default_model: 'deepseek-v4-flash',
};

const GLM = {
  base_url: 'https://open.bigmodel.cn/api/paas/v4',
  api_key_env: 'ZAI_API_KEY',
  default_model: 'glm-4.7-flash',
};

function pluginConfig(): AgentPluginConfig {
  return {
    default_api_profile: 'deepseek-main',
    api_profiles: {
      'deepseek-main': DEEPSEEK,
      'glm-review': GLM,
    },
    spawn_presets: [
      {
        name: 'code-review-bug',
        prompt_file: 'agents/code-review-bug.md',
        tools: ['read_file'],
        api_profile: 'glm-review',
        model: 'glm-4.7-flash',
      },
      {
        name: 'web-researcher',
        prompt_file: 'agents/web-researcher.md',
        tools: ['web_fetch'],
      },
    ],
  };
}

describe('spawn preset llm binding', () => {
  it('applies preset api_profile to child AgentConfig', () => {
    const parent: AgentConfig = {
      apiKey: 'ds-key',
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-v4-flash',
      maxTurns: 0,
      cwd: '/tmp',
      allowShell: false,
      allowWeb: false,
      llm: {
        profileName: 'deepseek-main',
        baseUrl: 'https://api.deepseek.com',
        apiKey: 'ds-key',
        model: 'deepseek-v4-flash',
        wire: 'openai_chat',
        available: true,
      },
      llmPluginConfig: pluginConfig(),
    };

    const binding = resolvePresetLlmBinding(
      parent.llmPluginConfig!,
      'code-review-bug',
      parent.llm,
      { env: { ZAI_API_KEY: 'glm-key' } },
    );

    assert.equal(binding.profileName, 'glm-review');
    assert.equal(binding.model, 'glm-4.7-flash');
    assert.equal(binding.available, true);

    const child: AgentConfig = { ...parent, spawnDepth: 1 };
    applyLlmBindingToAgentConfig(child, binding);

    assert.equal(child.llm?.profileName, 'glm-review');
    assert.equal(child.apiKey, 'glm-key');
    assert.equal(child.model, 'glm-4.7-flash');
    assert.notEqual(child.apiKey, parent.apiKey);
  });

  it('inherits parent profile when preset omits api_profile', () => {
    const parentLlm = {
      profileName: 'deepseek-main',
      baseUrl: 'https://api.deepseek.com',
      apiKey: 'ds-key',
      model: 'deepseek-v4-flash',
      wire: 'openai_chat' as const,
      available: true,
    };

    const binding = resolvePresetLlmBinding(
      pluginConfig(),
      'web-researcher',
      parentLlm,
      { env: { DEEPSEEK_API_KEY: 'ds-key' } },
    );

    assert.equal(binding.profileName, 'deepseek-main');
    assert.equal(binding.model, 'deepseek-v4-flash');
  });
});