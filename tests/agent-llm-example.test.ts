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

  it('binds code-review-bug preset to review-cheap profile', () => {
    const example = loadExample();
    const main = resolveLlmBinding(example, {
      env: { DEEPSEEK_API_KEY: 'ds-test' },
    });

    const review = resolvePresetLlmBinding(example, 'code-review-bug', main, {
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
});