import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildLlmTurnRequestForBinding } from '../src/llm-cache.js';
import { buildChatBody } from '../src/llm.js';
import {
  buildSessionReasoningExtraBody,
  listReasoningLevels,
  resolveReasoningPatch,
} from '../src/llm-reasoning.js';
import type { ResolvedLlmBinding } from '../src/llm-profiles.js';
import type { AgentConfig } from '../src/types.js';

const DEEPSEEK_BINDING: ResolvedLlmBinding = {
  profileName: 'deepseek-main',
  baseUrl: 'https://api.deepseek.com',
  apiKey: 'ds-key',
  model: 'deepseek-v4-flash',
  wire: 'openai_chat',
  available: true,
  extraBody: { temperature: 1 },
  reasoningMap: {
    low: {
      thinking: { type: 'enabled' },
      reasoning_effort: 'low',
    },
    high: {
      thinking: { type: 'enabled' },
      reasoning_effort: 'high',
    },
  },
};

const XAI_BINDING: ResolvedLlmBinding = {
  profileName: 'xai-test',
  baseUrl: 'https://api.x.ai/v1',
  apiKey: 'xai-key',
  model: 'grok-4.3',
  wire: 'openai_chat',
  available: true,
  extraBody: { reasoning_effort: 'low' },
  reasoningMap: {
    medium: { reasoning_effort: 'medium' },
    none: { reasoning_effort: 'none' },
  },
};

describe('llm-reasoning (G4)', () => {
  it('lists reasoning_map keys sorted', () => {
    assert.deepEqual(listReasoningLevels(DEEPSEEK_BINDING.reasoningMap), ['high', 'low']);
  });

  it('resolves DeepSeek thinking + reasoning_effort patch', () => {
    assert.deepEqual(resolveReasoningPatch(DEEPSEEK_BINDING.reasoningMap, 'high'), {
      thinking: { type: 'enabled' },
      reasoning_effort: 'high',
    });
  });

  it('resolves xAI reasoning_effort patch', () => {
    assert.deepEqual(resolveReasoningPatch(XAI_BINDING.reasoningMap, 'medium'), {
      reasoning_effort: 'medium',
    });
  });

  it('merges profile.extra_body < session reasoning per §9.1', () => {
    const config = {
      apiKey: 'ds-key',
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-v4-flash',
      cwd: '/tmp',
      sessionReasoningLevel: 'high',
      llm: {
        profileName: 'deepseek-main',
        baseUrl: 'https://api.deepseek.com',
        apiKey: 'ds-key',
        model: 'deepseek-v4-flash',
        wire: 'openai_chat' as const,
        available: true,
        extraBody: { temperature: 1 },
        reasoningMap: DEEPSEEK_BINDING.reasoningMap,
      },
    } satisfies AgentConfig;

    const turn = buildLlmTurnRequestForBinding(
      config,
      DEEPSEEK_BINDING,
      [{ role: 'user', content: 'hi' }],
      { stream: false },
    );

    const body = buildChatBody(
      turn.chatOpts.model,
      turn.apiMessages,
      [],
      false,
      turn.chatOpts.extraBody,
    );

    assert.equal(body.temperature, 1);
    assert.deepEqual(body.thinking, { type: 'enabled' });
    assert.equal(body.reasoning_effort, 'high');
  });

  it('session patch overrides profile extra_body reasoning_effort (xAI)', () => {
    const patch = buildSessionReasoningExtraBody(XAI_BINDING, 'none');
    assert.deepEqual(patch, { reasoning_effort: 'none' });

    const config = {
      apiKey: XAI_BINDING.apiKey,
      baseUrl: XAI_BINDING.baseUrl,
      model: XAI_BINDING.model,
      cwd: '/tmp',
      sessionReasoningLevel: 'none',
    } satisfies AgentConfig;

    const turn = buildLlmTurnRequestForBinding(
      config,
      XAI_BINDING,
      [{ role: 'user', content: 'hi' }],
      { stream: false },
    );

    const body = buildChatBody(
      turn.chatOpts.model,
      turn.apiMessages,
      [],
      false,
      turn.chatOpts.extraBody,
    );

    assert.equal(body.reasoning_effort, 'none');
  });
});