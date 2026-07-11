import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';

import { formatRunStartLlmSummary } from '../src/events.js';
import { AgentRuntime } from '../src/runner.js';
import { loadSession } from '../src/session.js';
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

  it('parses /profile and /model', () => {
    assert.deepEqual(parseSlashLine('/profile'), {
      handled: true,
      llmAction: { kind: 'profile', mode: 'list' },
    });
    assert.match(parseSlashLine('/provider glm-main')?.message ?? '', /use \/profile/);
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

  it('re-selecting the same profile keeps model override', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ma-tui-llm-slash-same-'));
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
        },
      }),
    );

    process.env.DEEPSEEK_API_KEY = 'ds-key';
    delete process.env.OPENAI_API_KEY;

    const runtime = new AgentRuntime({ cwd: dir, deferSession: true });
    runtime.newSession();

    runtime.setSessionLlmModel('deepseek-v4-pro');
    assert.match(runtime.formatSessionLlmShortLine(), /deepseek-v4-pro\*$/);

    const setSameProfile = runtime.setSessionLlmProfile('deepseek-main');
    assert.equal(setSameProfile.ok, true);
    assert.match(setSameProfile.message, /deepseek-main\/deepseek-v4-pro/);
    assert.equal(runtime.getSessionLlmOverride().model, 'deepseek-v4-pro');
    assert.match(runtime.formatSessionLlmShortLine(), /deepseek-v4-pro\*$/);
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

  it('listSessionProfileChoices marks effective profile active, not stale config.llm', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ma-tui-llm-slash-active-'));
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
    delete process.env.OPENAI_API_KEY;

    const runtime = new AgentRuntime({ cwd: dir, deferSession: true });
    runtime.newSession();
    runtime.setSessionLlmModel('deepseek-v4-pro');
    runtime.config.llm = {
      profileName: 'glm-main',
      baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
      apiKey: 'glm-key',
      model: 'glm-5.2',
      wire: 'openai',
      available: true,
    };

    const choices = runtime.listSessionProfileChoices();
    assert.equal(
      choices.find((c) => c.name === 'deepseek-main')?.active,
      true,
    );
    assert.equal(choices.find((c) => c.name === 'glm-main')?.active, false);
  });

  it('hasSessionLlmOverride ignores whitespace-only override fields', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ma-tui-llm-slash-empty-'));
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
          },
        },
      }),
    );

    process.env.DEEPSEEK_API_KEY = 'ds-key';
    delete process.env.OPENAI_API_KEY;

    const runtime = new AgentRuntime({ cwd: dir, deferSession: true });
    runtime.newSession();

    const rejected = runtime.setSessionLlmProfile('   ');
    assert.equal(rejected.ok, false);
    assert.equal(runtime.hasSessionLlmOverride(), false);

    runtime.setSessionLlmModel('deepseek-v4-flash');
    runtime.resetSessionLlmModel();
    assert.equal(runtime.hasSessionLlmOverride(), false);
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

  it('rejects /model when id is not in profile catalog', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ma-tui-llm-slash-invalid-'));
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
        },
      }),
    );

    process.env.DEEPSEEK_API_KEY = 'ds-key';
    delete process.env.OPENAI_API_KEY;

    const runtime = new AgentRuntime({ cwd: dir, deferSession: true });
    runtime.newSession();

    const rejected = runtime.setSessionLlmModel('deepseek-v4-typo');
    assert.equal(rejected.ok, false);
    assert.match(rejected.message, /not in profile/);
    assert.match(runtime.formatSessionLlmShortLine(), /deepseek-v4-flash$/);
    assert.equal(runtime.formatSessionLlmShortLine().includes('*'), false);
  });

  it('persists model override across resume and process restart', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ma-tui-llm-slash-resume-'));
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
            reasoning_map: {
              high: { thinking: { type: 'enabled' }, reasoning_effort: 'high' },
            },
          },
        },
      }),
    );

    process.env.DEEPSEEK_API_KEY = 'ds-key';
    delete process.env.OPENAI_API_KEY;

    const runtime = new AgentRuntime({ cwd: dir, deferSession: true });
    runtime.newSession();
    const sessionId = runtime.sessionLabel();

    runtime.setSessionLlmModel('deepseek-v4-pro');
    runtime.setSessionReasoningLevel('high');
    assert.match(runtime.formatSessionLlmShortLine(), /deepseek-v4-pro\* r:high$/);

    const onDisk = loadSession(sessionId);
    assert.ok(onDisk?.llm_override);
    assert.equal(onDisk.llm_override?.model, 'deepseek-v4-pro');
    assert.equal(onDisk.llm_override?.reasoningLevel, 'high');

    const resumed = new AgentRuntime({ cwd: dir, resumeSessionId: sessionId });
    assert.match(
      resumed.formatSessionLlmShortLine(),
      /deepseek-v4-pro\* r:high$/,
    );
    assert.equal(resumed.getSessionLlmOverride().model, 'deepseek-v4-pro');
    assert.equal(resumed.getSessionReasoningLevel(), 'high');

    const runtime2 = new AgentRuntime({ cwd: dir, deferSession: true });
    assert.ok(runtime2.resumeSession(sessionId));
    assert.match(
      runtime2.formatSessionLlmShortLine(),
      /deepseek-v4-pro\* r:high$/,
    );
  });
});