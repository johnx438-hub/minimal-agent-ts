import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { CHARS_PER_TOKEN, createBudgetConfig } from '../src/context/budget.js';
import {
  applyPointerSecondaryCompact,
  assembleApiMessages,
  maybeCompactPointerCards,
  pointerCompactThreshold,
  shouldCompactPointerCards,
} from '../src/context-policy.js';
import { buildPointerCard } from '../src/pointerize.js';
import type { ActionBlock, ChatMessage } from '../src/types.js';

const budget = createBudgetConfig('deepseek/deepseek-chat');

function fillerTokens(targetTokens: number): string {
  return 'x'.repeat(Math.ceil(targetTokens * CHARS_PER_TOKEN) + 50);
}

function sampleBlock(actionId: string): ActionBlock {
  return {
    action_id: actionId,
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
}

describe('pointer secondary compact', () => {
  it('downgrades pointer cards to compacted stubs with action_id', () => {
    const msg: ChatMessage = {
      role: 'tool',
      content: buildPointerCard(sampleBlock('act_old')),
      action_id: 'act_old',
      pointerized: true,
      turn: 2,
    };

    applyPointerSecondaryCompact(msg);

    assert.ok(msg.compacted_at);
    assert.equal(msg.content, '[compacted tool action_id=act_old turn=2]');
    assert.equal(msg.pointerized, true);
  });

  it('omits secondary-compacted pointer cards from API messages', () => {
    const msg: ChatMessage = {
      role: 'tool',
      content: buildPointerCard(sampleBlock('act_old')),
      action_id: 'act_old',
      pointerized: true,
      turn: 2,
    };
    applyPointerSecondaryCompact(msg);

    const api = assembleApiMessages([{ role: 'system', content: 'sys' }, msg]);
    assert.equal(api.length, 1);
    assert.equal(api[0]?.role, 'system');
  });

  it('compacts oldest pointer cards when above 80% usable', () => {
    const threshold = pointerCompactThreshold(budget);
    const over = threshold + 500;
    assert.equal(shouldCompactPointerCards(over, budget), true);

    const messages: ChatMessage[] = [
      { role: 'system', content: 'sys' },
      {
        role: 'tool',
        content: buildPointerCard(sampleBlock('act_1')),
        action_id: 'act_1',
        pointerized: true,
        turn: 2,
      },
      {
        role: 'tool',
        content: buildPointerCard(sampleBlock('act_2')),
        action_id: 'act_2',
        pointerized: true,
        turn: 3,
      },
      { role: 'user', content: fillerTokens(over), turn: 4 },
    ];

    const compacted = maybeCompactPointerCards(messages, 5, budget);
    assert.ok(compacted >= 1);
    assert.ok(messages[1]?.compacted_at, 'oldest pointer card is downgraded first');
    assert.equal(messages[1]?.content, '[compacted tool action_id=act_1 turn=2]');
  });
});