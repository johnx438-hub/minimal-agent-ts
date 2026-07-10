import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';

import { buildRunStartLlmMeta } from '../src/llm-profiles.js';
import { AgentRuntime } from '../src/runner.js';
import { parseSlashLine } from '../src/tui/slash.js';

const ENV_KEYS = ['OPENAI_API_KEY', 'DEEPSEEK_API_KEY', 'ZAI_API_KEY'] as const;

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

describe('TUI reasoning slash (G4)', () => {
  let savedEnv = snapshotEnv();

  afterEach(() => {
    restoreEnv(savedEnv);
    savedEnv = snapshotEnv();
  });

  it('parses /reasoning list, set, and reset', () => {
    assert.deepEqual(parseSlashLine('/reasoning'), {
      handled: true,
      llmAction: { kind: 'reasoning', mode: 'list' },
    });
    assert.deepEqual(parseSlashLine('/reasoning high'), {
      handled: true,
      llmAction: { kind: 'reasoning', mode: 'set', level: 'high' },
    });
    assert.deepEqual(parseSlashLine('/reasoning reset'), {
      handled: true,
      llmAction: { kind: 'reasoning', mode: 'reset' },
    });
  });

  it('session reasoning applies in buildRunConfig extra_body path', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ma-tui-reasoning-'));
    writeFileSync(
      join(dir, 'agent.json'),
      JSON.stringify({
        default_api_profile: 'deepseek-main',
        api_profiles: {
          'deepseek-main': {
            base_url: 'https://api.deepseek.com',
            api_key_env: 'DEEPSEEK_API_KEY',
            default_model: 'deepseek-v4-flash',
            models: ['deepseek-v4-flash'],
            reasoning_map: {
              low: {
                thinking: { type: 'enabled' },
                reasoning_effort: 'low',
              },
              high: {
                thinking: { type: 'enabled' },
                reasoning_effort: 'high',
              },
            },
          },
        },
      }),
    );

    process.env.DEEPSEEK_API_KEY = 'ds-key';
    delete process.env.OPENAI_API_KEY;

    const runtime = new AgentRuntime({ cwd: dir, deferSession: true });
    runtime.newSession();

    const set = runtime.setSessionReasoningLevel('high');
    assert.equal(set.ok, true);
    assert.match(runtime.formatSessionLlmShortLine(), /r:high/);
    assert.equal(runtime.getSessionReasoningLevel(), 'high');

    const meta = buildRunStartLlmMeta(
      { profileName: 'deepseek-main', model: 'deepseek-v4-flash', wire: 'openai_chat', baseUrl: 'x', apiKey: 'k', available: true },
      'high',
    );
    assert.equal(meta?.reasoning, 'high');

    runtime.resetSessionReasoningLevel();
    assert.equal(runtime.getSessionReasoningLevel(), undefined);
  });

  it('clears reasoning on profile change', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ma-tui-reasoning-profile-'));
    writeFileSync(
      join(dir, 'agent.json'),
      JSON.stringify({
        default_api_profile: 'deepseek-main',
        api_profiles: {
          'deepseek-main': {
            base_url: 'https://api.deepseek.com',
            api_key_env: 'DEEPSEEK_API_KEY',
            default_model: 'deepseek-v4-flash',
            models: ['deepseek-v4-flash'],
            reasoning_map: { high: { reasoning_effort: 'high' } },
          },
          'glm-main': {
            base_url: 'https://open.bigmodel.cn/api/paas/v4',
            api_key_env: 'ZAI_API_KEY',
            default_model: 'glm-5.2',
            models: ['glm-5.2'],
            reasoning_map: { low: { reasoning_effort: 'low' } },
          },
        },
      }),
    );

    process.env.DEEPSEEK_API_KEY = 'ds-key';
    process.env.ZAI_API_KEY = 'glm-key';
    delete process.env.OPENAI_API_KEY;

    const runtime = new AgentRuntime({ cwd: dir, deferSession: true });
    runtime.newSession();
    runtime.setSessionReasoningLevel('high');
    runtime.setSessionLlmProfile('glm-main');
    assert.equal(runtime.getSessionReasoningLevel(), undefined);
  });

  it('rejects unknown reasoning level', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ma-tui-reasoning-bad-'));
    writeFileSync(
      join(dir, 'agent.json'),
      JSON.stringify({
        default_api_profile: 'deepseek-main',
        api_profiles: {
          'deepseek-main': {
            base_url: 'https://api.deepseek.com',
            api_key_env: 'DEEPSEEK_API_KEY',
            default_model: 'deepseek-v4-flash',
            reasoning_map: { low: { reasoning_effort: 'low' } },
          },
        },
      }),
    );

    process.env.DEEPSEEK_API_KEY = 'ds-key';
    delete process.env.OPENAI_API_KEY;

    const runtime = new AgentRuntime({ cwd: dir, deferSession: true });
    runtime.newSession();

    const bad = runtime.setSessionReasoningLevel('ultra');
    assert.equal(bad.ok, false);
    assert.match(bad.message, /unknown reasoning level/);
  });
});