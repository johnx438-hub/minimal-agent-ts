import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  formatRunStartLlmSummary,
  parseJsonEventLine,
  serializeRuntimeEvent,
} from '../src/events.js';
import {
  buildRunStartLlmMeta,
  llmBaseUrlHost,
} from '../src/llm-profiles.js';
import type { LlmProfile } from '../src/types.js';

function sampleLlm(overrides: Partial<LlmProfile> = {}): LlmProfile {
  return {
    profileName: 'deepseek-main',
    baseUrl: 'https://api.deepseek.com',
    apiKey: 'secret-not-in-events',
    model: 'deepseek-v4-flash',
    wire: 'openai_chat',
    cache: { mode: 'implicit', telemetry: true },
    available: true,
    ...overrides,
  };
}

describe('run_start.llm (G2-a)', () => {
  it('llmBaseUrlHost extracts host without path', () => {
    assert.equal(llmBaseUrlHost('https://open.bigmodel.cn/api/paas/v4'), 'open.bigmodel.cn');
    assert.equal(llmBaseUrlHost('https://api.deepseek.com/'), 'api.deepseek.com');
    assert.equal(llmBaseUrlHost('not-a-url'), undefined);
    assert.equal(llmBaseUrlHost('://bad'), undefined);
  });

  it('buildRunStartLlmMeta omits secrets and normalizes cache_mode', () => {
    const meta = buildRunStartLlmMeta(sampleLlm());
    assert.ok(meta);
    assert.equal(meta!.profile, 'deepseek-main');
    assert.equal(meta!.model, 'deepseek-v4-flash');
    assert.equal(meta!.cache_mode, 'implicit');
    assert.equal(meta!.base_url_host, 'api.deepseek.com');
    assert.equal('apiKey' in (meta as object), false);
  });

  it('buildRunStartLlmMeta defaults cache_mode to off', () => {
    const meta = buildRunStartLlmMeta(sampleLlm({ cache: undefined }));
    assert.equal(meta?.cache_mode, 'off');
  });

  it('formatRunStartLlmSummary skips off cache and includes host', () => {
    assert.equal(
      formatRunStartLlmSummary({
        profile: 'glm-main',
        model: 'glm-5.2',
        cache_mode: 'implicit',
        base_url_host: 'open.bigmodel.cn',
      }),
      'glm-main/glm-5.2 cache=implicit host=open.bigmodel.cn',
    );
    assert.equal(
      formatRunStartLlmSummary({
        profile: '__env__',
        model: 'gemini-2.0-flash',
        cache_mode: 'off',
      }),
      '__env__/gemini-2.0-flash',
    );
  });

  it('serializes run_start.llm on --json-events wire', () => {
    const line = serializeRuntimeEvent({
      type: 'run_start',
      session_id: 'sess_g2a',
      cwd: '/tmp/project',
      llm: {
        profile: 'deepseek-main',
        model: 'deepseek-v4-pro',
        cache_mode: 'implicit',
        base_url_host: 'api.deepseek.com',
      },
    });
    const parsed = parseJsonEventLine(line);
    assert.equal(parsed.event.type, 'run_start');
    if (parsed.event.type !== 'run_start') return;
    assert.equal(parsed.event.llm?.profile, 'deepseek-main');
    assert.equal(parsed.event.llm?.model, 'deepseek-v4-pro');
    assert.equal(parsed.event.llm?.cache_mode, 'implicit');
    assert.equal(parsed.event.llm?.base_url_host, 'api.deepseek.com');
    assert.equal(line.includes('secret'), false);
    assert.equal(line.includes('apiKey'), false);
  });
});