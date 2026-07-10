import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';

import { formatRunStartLlmSummary } from '../src/events.js';
import { AgentRuntime } from '../src/runner.js';
import { parseSlashLine } from '../src/tui/slash.js';

const ENV_KEYS = ['OPENAI_API_KEY', 'DEEPSEEK_API_KEY', 'ZAI_API_KEY', 'MODEL'] as const;

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

describe('TUI llm slash (G2-c)', () => {
  let savedEnv = snapshotEnv();

  afterEach(() => {
    restoreEnv(savedEnv);
    savedEnv = snapshotEnv();
  });

  it('parses /profile /provider and /model', () => {
    assert.deepEqual(parseSlashLine('/profile'), {
      handled: true,
      llmAction: { kind: 'profile', mode: 'list' },
    });
    assert.deepEqual(parseSlashLine('/provider glm-main'), {
      handled: true,
      llmAction: { kind: 'profile', mode: 'set', name: 'glm-main' },
    });
    assert.deepEqual(parseSlashLine('/profile reset'), {
      handled: true,
      llmAction: { kind: 'profile', mode: 'reset' },
    });
    assert.deepEqual(parseSlashLine('/model'), {
      handled: true,
      llmAction: { kind: 'model', mode: 'list' },
    });
    assert.deepEqual(parseSlashLine('/model deepseek-v4-pro'), {
      handled: true,
      llmAction: { kind: 'model', mode: 'set', model: 'deepseek-v4-pro' },
    });
    assert.deepEqual(parseSlashLine('/model reset'), {
      handled: true,
      llmAction: { kind: 'model', mode: 'reset' },
    });
  });

  it('session override applies in buildRunConfig and clears model on profile switch', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ma-tui-llm-slash-'));
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
            models: ['glm-5.2', 'glm-4.7-flash'],
          },
        },
      }),
    );

    process.env.DEEPSEEK_API_KEY = 'ds-key';
    process.env.ZAI_API_KEY = 'glm-key';
    delete process.env.OPENAI_API_KEY;

    const runtime = new AgentRuntime({ cwd: dir, deferSession: true });
    runtime.newSession();

    const setModel = runtime.setSessionLlmModel('deepseek-v4-pro');
    assert.equal(setModel.ok, true);
    assert.match(runtime.formatSessionLlmShortLine(), /deepseek-v4-pro\*$/);

    const setProfile = runtime.setSessionLlmProfile('glm-main');
    assert.equal(setProfile.ok, true);
    assert.match(runtime.formatSessionLlmShortLine(), /^llm:glm-main\/glm-5\.2\*$/);
    assert.equal(runtime.getSessionLlmOverride().model, undefined);

    runtime.setSessionLlmModel('glm-4.7-flash');
    assert.match(runtime.formatSessionLlmShortLine(), /glm-4\.7-flash\*$/);

    runtime.resetSessionLlmModel();
    assert.match(runtime.formatSessionLlmShortLine(), /glm-5\.2\*$/);
    assert.equal(runtime.getSessionLlmOverride().model, undefined);

    runtime.resetSessionLlmOverride();
    assert.equal(runtime.hasSessionLlmOverride(), false);
    assert.match(runtime.formatSessionLlmShortLine(), /deepseek-v4-flash$/);
    assert.equal(runtime.formatSessionLlmShortLine().includes('*'), false);
  });

  it('formatRunStartLlmSummary marks session_override', () => {
    assert.equal(
      formatRunStartLlmSummary({
        profile: 'glm-main',
        model: 'glm-5.2',
        session_override: true,
      }),
      'glm-main/glm-5.2 (override)',
    );
  });
});