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
  shouldPrune,
} from '../src/context-policy.js';
import type { ChatMessage } from '../src/types.js';

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
    const visible: ChatMessage = {
      role: 'tool',
      content: 'inline',
      action_id: 'act_live',
      pointerized: false,
      turn: 3,
    };
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
      visible,
    ]);

    assert.equal(api.length, 2);
    assert.deepEqual(api[1], { role: 'tool', content: 'inline' });
    assert.equal('action_id' in (api[1] ?? {}), false);
    assert.equal('pointerized' in (api[1] ?? {}), false);
    assert.equal('turn' in (api[1] ?? {}), false);
  });
});