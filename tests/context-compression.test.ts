import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  CHARS_PER_TOKEN,
  createBudgetConfig,
  heavyCompressionThreshold,
  shouldRunHeavyCompression,
} from '../src/context/budget.js';
import {
  appendCompressionNotice,
  hasCompressionNotice,
  runCompressionEvent,
} from '../src/context-policy.js';
import type { ChatMessage, SessionFile, TaskSummaryDoc } from '../src/types.js';
import { TASK_SUMMARY_PREFIX } from '../src/context/estimate.js';

const budget = createBudgetConfig('deepseek/deepseek-chat');

function fillerTokens(targetTokens: number): string {
  return 'x'.repeat(Math.ceil(targetTokens * CHARS_PER_TOKEN) + 50);
}

function overFirstThresholdTokens(): number {
  return heavyCompressionThreshold(budget, false) + 1000;
}

function betweenFirstAndRepeatTokens(): number {
  const first = heavyCompressionThreshold(budget, false);
  const repeat = heavyCompressionThreshold(budget, true);
  assert.ok(first < repeat);
  return first + Math.floor((repeat - first) / 2);
}

describe('shouldRunHeavyCompression', () => {
  it('uses 80% usable for first compression', () => {
    const threshold = heavyCompressionThreshold(budget, false);
    assert.equal(shouldRunHeavyCompression(threshold, budget, false), false);
    assert.equal(shouldRunHeavyCompression(threshold + 1, budget, false), true);
  });

  it('uses 90% usable for repeat compression', () => {
    const first = heavyCompressionThreshold(budget, false);
    const repeat = heavyCompressionThreshold(budget, true);
    const mid = betweenFirstAndRepeatTokens();

    assert.ok(mid > first);
    assert.ok(mid < repeat);
    assert.equal(shouldRunHeavyCompression(mid, budget, false), true);
    assert.equal(shouldRunHeavyCompression(mid, budget, true), false);
    assert.equal(shouldRunHeavyCompression(repeat + 1, budget, true), true);
  });
});

describe('runCompressionEvent', () => {
  it('replays user task only on first heavy compression', () => {
    const userTask: ChatMessage = { role: 'user', content: 'do the thing' };
    const messages: ChatMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: fillerTokens(overFirstThresholdTokens()) },
    ];

    const first = runCompressionEvent({
      messages,
      currentTurn: 3,
      budget,
      userTask,
    });
    assert.equal(first, true);
    assert.equal(hasCompressionNotice(messages), true);
    const userCountAfterFirst = messages.filter((m) => m.role === 'user').length;

    messages.push({
      role: 'assistant',
      content: fillerTokens(heavyCompressionThreshold(budget, true) + 2000),
      turn: 4,
    });

    const second = runCompressionEvent({
      messages,
      currentTurn: 5,
      budget,
      userTask,
    });
    assert.equal(second, true);
    assert.equal(
      messages.filter((m) => m.role === 'user').length,
      userCountAfterFirst,
      'repeat compression must not replay user task',
    );
  });

  it('injects mid/early summaries only, not recent tasks still in context', () => {
    const savedContextLimit = process.env.MAX_CONTEXT_TOKENS;
    process.env.MAX_CONTEXT_TOKENS = '30000';
    const smallBudget = createBudgetConfig('unknown-model');

    const userTask: ChatMessage = { role: 'user', content: 'do the thing' };
    const makeTask = (id: string): TaskSummaryDoc => ({
      task_id: id,
      user_intent: `intent ${id}`,
      user_messages: [],
      files_touched: [`${id}.ts`],
      tech_concepts: ['ts'],
      tools_used: ['read_file'],
      pending_tasks: [],
      current_work: `work ${id}`,
    });

    const session: SessionFile = {
      session_id: 's1',
      tasks: [
        makeTask('mid-old'),
        makeTask('mid-old-2'),
        {
          ...makeTask('recent-live'),
          user_intent: `intent recent-live${'z'.repeat(7_100)}`,
        },
      ],
      current_messages: [],
    };

    const messages: ChatMessage[] = [
      { role: 'system', content: 'sys' },
      {
        role: 'user',
        content: fillerTokens(heavyCompressionThreshold(smallBudget, false) + 1000),
      },
    ];

    try {
      runCompressionEvent({
        messages,
        session,
        currentTurn: 3,
        budget: smallBudget,
        userTask,
      });

      const summaryBodies = messages
        .filter((m) => (m.content ?? '').startsWith(TASK_SUMMARY_PREFIX))
        .map((m) => m.content ?? '');

      assert.ok(summaryBodies.some((c) => c.includes('mid-old')));
      assert.ok(summaryBodies.some((c) => c.includes('mid-old-2')));
      assert.ok(!summaryBodies.some((c) => c.includes('recent-live')));
    } finally {
      if (savedContextLimit === undefined) {
        delete process.env.MAX_CONTEXT_TOKENS;
      } else {
        process.env.MAX_CONTEXT_TOKENS = savedContextLimit;
      }
    }
  });

  it('does not run repeat compression below 90% usable', () => {
    const userTask: ChatMessage = { role: 'user', content: 'task' };
    const messages: ChatMessage[] = [
      { role: 'system', content: 'sys' },
      appendCompressionNotice([]),
      { role: 'user', content: fillerTokens(betweenFirstAndRepeatTokens()) },
    ];

    const applied = runCompressionEvent({
      messages,
      currentTurn: 4,
      budget,
      userTask,
    });
    assert.equal(applied, false);
  });
});