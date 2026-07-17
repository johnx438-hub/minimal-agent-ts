import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { assembleApiMessages } from '../src/context/assemble.js';
import {
  appendReasoningDelta,
  extractReasoningText,
  normalizeReasoningText,
  projectReasoningForApi,
  withReasoningContent,
} from '../src/llm-reasoning-content.js';
import { commitAssistantText, commitAssistantToolCalls } from '../src/stream-draft.js';
import type { ChatMessage } from '../src/types.js';

describe('llm-reasoning-content', () => {
  it('extracts reasoning_content and reasoning aliases', () => {
    assert.equal(
      extractReasoningText({ reasoning_content: 'think hard' }),
      'think hard',
    );
    assert.equal(extractReasoningText({ reasoning: 'alt' }), 'alt');
    assert.equal(extractReasoningText({ content: 'no' }), undefined);
    assert.equal(extractReasoningText(null), undefined);
  });

  it('appends stream deltas', () => {
    let acc = '';
    acc = appendReasoningDelta(acc, { reasoning_content: 'a' });
    acc = appendReasoningDelta(acc, { reasoning_content: 'b' });
    acc = appendReasoningDelta(acc, { content: 'ignored' });
    assert.equal(acc, 'ab');
    assert.equal(normalizeReasoningText('  x  '), 'x');
    assert.equal(normalizeReasoningText('   '), undefined);
  });

  it('withReasoningContent attaches only non-empty', () => {
    const base: ChatMessage = { role: 'assistant', content: 'hi' };
    assert.equal(withReasoningContent(base, undefined).reasoning_content, undefined);
    assert.equal(withReasoningContent(base, '  co t  ').reasoning_content, 'co t');
  });

  it('projectReasoningForApi strips unless preserve', () => {
    const msg: ChatMessage = {
      role: 'assistant',
      content: 'ans',
      reasoning_content: 'secret',
    };
    assert.equal(projectReasoningForApi(msg, false).reasoning_content, undefined);
    assert.equal(projectReasoningForApi(msg, true).reasoning_content, 'secret');
  });

  it('commit helpers persist reasoning_content', () => {
    const msgs: ChatMessage[] = [];
    commitAssistantText(msgs, 'done', 1, { reasoning_content: 'step' });
    assert.equal(msgs[0]!.reasoning_content, 'step');

    const toolMsgs: ChatMessage[] = [];
    commitAssistantToolCalls(
      toolMsgs,
      {
        role: 'assistant',
        content: null,
        reasoning_content: 'plan',
        tool_calls: [
          {
            id: 'c1',
            type: 'function',
            function: { name: 'read_file', arguments: '{}' },
          },
        ],
      },
      2,
    );
    assert.equal(toolMsgs[0]!.reasoning_content, 'plan');
  });

  it('assembleApiMessages re-sends reasoning only when preserveReasoning', () => {
    const history: ChatMessage[] = [
      { role: 'user', content: 'q' },
      {
        role: 'assistant',
        content: 'a',
        reasoning_content: 'r1',
      },
      { role: 'user', content: 'q2' },
    ];

    const stripped = assembleApiMessages(history, { preserveReasoning: false });
    const asst = stripped.find((m) => m.role === 'assistant');
    assert.equal(asst?.reasoning_content, undefined);

    const kept = assembleApiMessages(history, { preserveReasoning: true });
    const asst2 = kept.find((m) => m.role === 'assistant');
    assert.equal(asst2?.reasoning_content, 'r1');
  });

  it('repair keeps reasoning on tool_calls assistant', () => {
    const history: ChatMessage[] = [
      {
        role: 'assistant',
        content: null,
        reasoning_content: 'before tool',
        tool_calls: [
          {
            id: 't1',
            type: 'function',
            function: { name: 'x', arguments: '{}' },
          },
        ],
      },
      { role: 'tool', tool_call_id: 't1', content: 'ok' },
    ];
    const out = assembleApiMessages(history, { preserveReasoning: true });
    assert.equal(out[0]!.reasoning_content, 'before tool');
    assert.equal(out[0]!.tool_calls?.[0]?.id, 't1');
  });
});
