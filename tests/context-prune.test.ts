import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  applyPrune,
  assembleApiMessages,
  estimatePruneSavings,
  maybePrune,
  PRUNE_MIN_SAVINGS,
  PROTECT_RECENT_TOKENS,
  PROTECT_USER_TURNS,
  repairToolCallPairs,
  shouldPrune,
} from '../src/context-policy.js';
import { buildPointerCard } from '../src/pointerize.js';
import type { ActionBlock, ChatMessage } from '../src/types.js';

/** estimateTokens counts ~1.3 tokens per whitespace-separated word. */
function fillerTokens(targetTokens: number): string {
  const wordsNeeded = Math.ceil(targetTokens / 1.3) + 50;
  return 'word '.repeat(wordsNeeded);
}

function oldPrunableTool(turn: number, tokens: number): ChatMessage {
  return {
    role: 'tool',
    content: fillerTokens(tokens),
    action_id: `act_${turn}`,
    turn,
  };
}

describe('context prune thresholds', () => {
  it('exports OpenCode-style prune constants', () => {
    assert.equal(PRUNE_MIN_SAVINGS, 20_000);
    assert.equal(PROTECT_RECENT_TOKENS, 40_000);
    assert.equal(PROTECT_USER_TURNS, 2);
  });

  it('does not prune when estimated savings are below 20k tokens', () => {
    const messages: ChatMessage[] = [
      { role: 'system', content: 'sys' },
      oldPrunableTool(1, 1_000),
      { role: 'user', content: 'older', turn: 98 },
      { role: 'user', content: 'recent', turn: 99 },
      { role: 'user', content: 'current', turn: 100 },
    ];

    assert.ok(estimatePruneSavings(messages, 100) < PRUNE_MIN_SAVINGS);
    assert.equal(shouldPrune(messages, 100), false);
    assert.equal(maybePrune(messages, 100), 0);
    assert.equal(messages[1]?.compacted_at, undefined);
  });

  it('prunes eligible old tool/assistant bodies when savings reach 20k', () => {
    const messages: ChatMessage[] = [
      { role: 'system', content: 'sys' },
      oldPrunableTool(1, PRUNE_MIN_SAVINGS + 500),
      {
        role: 'assistant',
        content: fillerTokens(PRUNE_MIN_SAVINGS + 500),
        turn: 2,
        tool_calls: [{ id: 'tc1', type: 'function', function: { name: 'read_file', arguments: '{}' } }],
      },
      {
        role: 'assistant',
        content: fillerTokens(PROTECT_RECENT_TOKENS - 1_000),
        turn: 50,
      },
      { role: 'user', content: 'older', turn: 98 },
      { role: 'user', content: 'recent', turn: 99 },
      { role: 'user', content: 'current', turn: 100 },
    ];

    assert.ok(estimatePruneSavings(messages, 100) >= PRUNE_MIN_SAVINGS);
    assert.equal(shouldPrune(messages, 100), true);

    const pruned = applyPrune(messages, 100);
    assert.equal(pruned, 2);
    assert.ok(messages[1]?.compacted_at);
    assert.equal(messages[1]?.content, '[compacted tool action_id=act_1]');
    assert.ok(messages[2]?.compacted_at);
    assert.equal(messages[2]?.content, '[compacted assistant]');
    assert.equal(messages[2]?.tool_calls, undefined);
    assert.equal(messages[3]?.compacted_at, undefined, 'recent tail buffer stays protected');
  });

  it('cascades prune to pointerized tool responses when assistant is pruned', () => {
    const block: ActionBlock = {
      action_id: 'act_ptr_prune',
      task_id: 'task_1',
      session_id: 'sess_1',
      turn_number: 1,
      tool_name: 'read_file',
      args_json: '{"path":"a.ts"}',
      result_text: 'content',
      result_hash: 'abc',
      byte_size: 7,
      line_count: 1,
      pointerized: true,
      files_touched: ['a.ts'],
      timestamp: Date.now(),
      token_cost: 1,
    };

    const messages: ChatMessage[] = [
      { role: 'system', content: 'sys' },
      {
        role: 'assistant',
        content: null,
        turn: 1,
        tool_calls: [
          {
            id: 'call_ptr',
            type: 'function',
            function: { name: 'read_file', arguments: '{"path":"a.ts"}' },
          },
        ],
      },
      {
        role: 'tool',
        tool_call_id: 'call_ptr',
        content: buildPointerCard(block),
        action_id: 'act_ptr_prune',
        pointerized: true,
        turn: 1,
      },
      {
        role: 'user',
        content: fillerTokens(PROTECT_RECENT_TOKENS + 5_000),
        turn: 50,
      },
      { role: 'user', content: 'older', turn: 98 },
      { role: 'user', content: 'recent', turn: 99 },
      { role: 'user', content: 'current', turn: 100 },
    ];

    const pruned = applyPrune(messages, 100);
    assert.equal(pruned, 2, 'assistant + cascaded pointerized tool');
    assert.ok(messages[1]?.compacted_at, 'assistant with tool_calls is pruned');
    assert.ok(messages[2]?.compacted_at, 'pointerized tool is cascaded');
    assert.equal(messages[2]?.content, '[compacted tool action_id=act_ptr_prune]');

    const api = assembleApiMessages(messages);
    assert.equal(api.some((m) => m.role === 'tool'), false);
  });

  it('skips immune and protected messages', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: fillerTokens(PRUNE_MIN_SAVINGS + 500), turn: 1 },
      {
        role: 'tool',
        content: `error: ${fillerTokens(PRUNE_MIN_SAVINGS + 500)}`,
        turn: 2,
      },
      {
        role: 'tool',
        content: fillerTokens(PRUNE_MIN_SAVINGS + 500),
        pointerized: true,
        action_id: 'act_ptr',
        turn: 3,
      },
      {
        role: 'user',
        content: '[context-notice] compressed earlier',
        turn: 4,
      },
      {
        role: 'user',
        content: '[Task task_1] summary block',
        turn: 5,
      },
      { role: 'user', content: 'penultimate', turn: 99 },
      { role: 'user', content: 'current', turn: 100 },
    ];

    const pruned = applyPrune(messages, 100);
    assert.equal(pruned, 0);
    for (const msg of messages) {
      assert.equal(msg.compacted_at, undefined);
    }
  });
});

describe('assembleApiMessages', () => {
  it('omits compacted messages and strips internal metadata', () => {
    const hidden: ChatMessage = {
      role: 'tool',
      content: '[compacted tool action_id=act_old]',
      action_id: 'act_old',
      pointerized: true,
      compacted_at: Date.now(),
      turn: 1,
    };

    const api = assembleApiMessages([
      { role: 'system', content: 'sys' },
      hidden,
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call_live',
            type: 'function',
            function: { name: 'read_file', arguments: '{}' },
          },
        ],
      },
      {
        role: 'tool',
        tool_call_id: 'call_live',
        content: 'inline',
        action_id: 'act_live',
        pointerized: false,
        turn: 3,
      },
    ]);

    assert.equal(api.length, 3);
    assert.equal(api[0]?.role, 'system');
    assert.equal(api[1]?.role, 'assistant');
    assert.deepEqual(api[2], { role: 'tool', tool_call_id: 'call_live', content: 'inline' });
    assert.equal('action_id' in (api[2] ?? {}), false);
    assert.equal('pointerized' in (api[2] ?? {}), false);
    assert.equal('turn' in (api[2] ?? {}), false);
  });

  it('drops orphan tool messages when assistant was compacted away', () => {
    const api = assembleApiMessages([
      { role: 'system', content: 'sys' },
      {
        role: 'assistant',
        content: null,
        compacted_at: Date.now(),
        tool_calls: [
          {
            id: 'call_old',
            type: 'function',
            function: { name: 'read_file', arguments: '{}' },
          },
        ],
      },
      {
        role: 'tool',
        tool_call_id: 'call_old',
        content: '[action:act_old]',
        pointerized: true,
      },
      { role: 'user', content: 'continue' },
    ]);

    assert.deepEqual(api, [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'continue' },
    ]);
  });

  it('trims assistant tool_calls when only some tool responses remain', () => {
    const repaired = repairToolCallPairs([
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'call_a', type: 'function', function: { name: 'read_file', arguments: '{}' } },
          { id: 'call_b', type: 'function', function: { name: 'grep_search', arguments: '{}' } },
        ],
      },
      { role: 'tool', tool_call_id: 'call_a', content: 'found a' },
    ]);

    assert.equal(repaired.length, 2);
    assert.equal(repaired[0]?.tool_calls?.length, 1);
    assert.equal(repaired[0]?.tool_calls?.[0]?.id, 'call_a');
    assert.equal(repaired[1]?.tool_call_id, 'call_a');
  });
});