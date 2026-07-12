import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  createBudgetConfig,
  heavyCompressionThreshold,
} from '../src/context-budget.js';
import { runTurnEndPipeline } from '../src/context/pipeline.js';
import { EMPTY_PIPELINE_RESULT } from '../src/context/types.js';
import { appendCompressionNotice } from '../src/context-policy.js';
import type { ChatMessage } from '../src/types.js';

const budget = createBudgetConfig('deepseek/deepseek-chat');

function fillerTokens(targetTokens: number): string {
  const wordsNeeded = Math.ceil(targetTokens / 1.3) + 50;
  return 'word '.repeat(wordsNeeded);
}

function overFirstThresholdTokens(): number {
  return heavyCompressionThreshold(budget, false) + 1000;
}

describe('context pipeline', () => {
  it('skips all stages on turn 1', () => {
    const messages: ChatMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'task' },
    ];

    const result = runTurnEndPipeline({
      messages,
      turn: 1,
      budget,
      userTask: messages[1]!,
    });

    assert.deepEqual(result, EMPTY_PIPELINE_RESULT);
  });

  it('runs prune and heavy compression stages on turn > 1', () => {
    const userTask: ChatMessage = { role: 'user', content: 'do the thing' };
    const messages: ChatMessage[] = [
      { role: 'system', content: 'sys' },
      {
        role: 'tool',
        content: fillerTokens(25_000),
        action_id: 'act_old',
        turn: 1,
      },
      { role: 'user', content: fillerTokens(overFirstThresholdTokens()) },
    ];

    const result = runTurnEndPipeline({
      messages,
      turn: 3,
      budget,
      userTask,
    });

    assert.ok(result.pruned > 0 || result.heavy_compression);
    if (result.heavy_compression) {
      assert.match(
        messages.map((m) => m.content ?? '').join('\n'),
        /\[context-notice\]/,
      );
    }
  });

  it('does not repeat heavy compression below repeat threshold', () => {
    const userTask: ChatMessage = { role: 'user', content: 'task' };
    const messages: ChatMessage[] = [
      { role: 'system', content: 'sys' },
      appendCompressionNotice([]),
      {
        role: 'user',
        content: fillerTokens(
          heavyCompressionThreshold(budget, false) +
            Math.floor(
              (heavyCompressionThreshold(budget, true) -
                heavyCompressionThreshold(budget, false)) /
                2,
            ),
        ),
      },
    ];

    const result = runTurnEndPipeline({
      messages,
      turn: 4,
      budget,
      userTask,
    });

    assert.equal(result.heavy_compression, false);
  });
});