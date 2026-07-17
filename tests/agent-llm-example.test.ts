import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  resolveDefaultProfileName,
  resolveLlmBinding,
  resolvePresetLlmBinding,
  validateApiProfiles,
} from '../src/llm-profiles.js';
import type { AgentPluginConfig } from '../src/plugins/types.js';

const EXAMPLE_PATH = join(import.meta.dirname, '..', 'agent.llm.example.json');

function loadExample(): AgentPluginConfig {
  return JSON.parse(readFileSync(EXAMPLE_PATH, 'utf8')) as AgentPluginConfig;
}

describe('agent.llm.example.json', () => {
  it('parses and validates api_profiles', () => {
    const example = loadExample();
    assert.ok(example.api_profiles);
    validateApiProfiles(example.api_profiles);
    assert.equal(resolveDefaultProfileName(example), 'deepseek-main');
  });

  it('resolves deepseek-main with env key', () => {
    const example = loadExample();
    const binding = resolveLlmBinding(example, {
      env: { DEEPSEEK_API_KEY: 'ds-test' },
    });

    assert.equal(binding.profileName, 'deepseek-main');
    assert.equal(binding.model, 'deepseek-v4-flash');
    assert.equal(binding.cache?.mode, 'implicit');
    assert.equal(binding.available, true);
  });

  it('documents spawn preset LLM overrides separately from full presets', () => {
    const raw = JSON.parse(readFileSync(EXAMPLE_PATH, 'utf8')) as Record<string, unknown>;
    const overrides = raw._spawn_preset_llm_overrides as Array<Record<string, unknown>>;
    assert.ok(Array.isArray(overrides));
    assert.equal(overrides[0]?.name, 'code-review-bug');
    assert.equal(overrides[0]?.api_profile, 'review-cheap');
    assert.equal(raw.spawn_presets, undefined);
  });

  it('binds code-review-bug when overrides are merged into spawn_presets', () => {
    const example = loadExample();
    const override = (
      JSON.parse(readFileSync(EXAMPLE_PATH, 'utf8')) as {
        _spawn_preset_llm_overrides: Array<{ name: string; api_profile?: string; model?: string }>;
      }
    )._spawn_preset_llm_overrides.find((o) => o.name === 'code-review-bug')!;

    const pluginConfig: AgentPluginConfig = {
      ...example,
      spawn_presets: [
        {
          name: 'code-review-bug',
          prompt_file: 'agents/code-review-bug.md',
          tools: ['read_file', 'grep_search', 'write_file'],
          api_profile: override.api_profile,
          model: override.model,
        },
      ],
    };

    const main = resolveLlmBinding(pluginConfig, {
      env: { DEEPSEEK_API_KEY: 'ds-test' },
    });

    const review = resolvePresetLlmBinding(pluginConfig, 'code-review-bug', main, {
      env: { ZAI_API_KEY: 'glm-test' },
    });

    assert.equal(review.profileName, 'review-cheap');
    assert.equal(review.model, 'glm-4.7-flash');
    assert.equal(review.apiKey, 'glm-test');
  });

  it('openrouter-test profile uses sticky cache mode', () => {
    const example = loadExample();
    const binding = resolveLlmBinding(example, {
      profileName: 'openrouter-test',
      env: { OPENROUTER_API_KEY: 'or-test' },
    });

    assert.equal(binding.cache?.mode, 'openrouter_sticky');
    assert.equal(binding.cache?.session_id_from, 'session_id');
  });

  it('kimi-main uses prompt_cache_key sticky and preserve_reasoning', () => {
    const example = loadExample();
    const binding = resolveLlmBinding(example, {
      profileName: 'kimi-main',
      env: { MOONSHOT_API_KEY: 'ms-test' },
    });

    assert.equal(binding.profileName, 'kimi-main');
    assert.equal(binding.cache?.mode, 'prompt_cache_key');
    assert.equal(binding.preserveReasoning, true);
    assert.equal(binding.available, true);
    assert.match(binding.baseUrl, /moonshot/);
  });
});