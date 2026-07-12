import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildContext,
  createBudgetConfig,
  estimateTokens,
  layerBudgets,
} from '../src/context/budget.js';
import { buildTaskSummaryMessages } from '../src/context/heavy-compression.js';
import type { SessionFile, TaskSummaryDoc } from '../src/types.js';

function makeTask(id: string, intentPad = ''): TaskSummaryDoc {
  return {
    task_id: id,
    user_intent: `intent ${id}${intentPad}`,
    user_messages: [],
    files_touched: [`file-${id}.ts`],
    tech_concepts: ['ts'],
    tools_used: ['read_file'],
    pending_tasks: [],
    current_work: `work ${id}`,
  };
}

describe('buildContext recent layer', () => {
  it('includes every recent-layer task up to budget, not a hard cap of three', () => {
    const budget = createBudgetConfig('deepseek/deepseek-chat');
    const tasks = Array.from({ length: 6 }, (_, i) => makeTask(`recent-${i}`));
    const session: SessionFile = {
      session_id: 's1',
      tasks,
      current_messages: [{ role: 'user', content: 'current' }],
    };

    const built = buildContext(session, budget);
    const recentMsgs = built.filter((m) => (m.content ?? '').startsWith('[Recent task '));

    assert.equal(recentMsgs.length, 6);
  });
});

describe('buildContext mid layer', () => {
  it('keeps mid tasks when recent layer is large', () => {
    const budget = createBudgetConfig('deepseek/deepseek-chat');
    const heavyPad = 'z'.repeat(40_000);
    const tasks = [
      ...Array.from({ length: 8 }, (_, i) => makeTask(`mid-${i}`)),
      ...Array.from({ length: 12 }, (_, i) => makeTask(`recent-${i}`, heavyPad)),
    ];
    const session: SessionFile = {
      session_id: 's1',
      tasks,
      current_messages: [{ role: 'user', content: 'current' }],
    };

    const built = buildContext(session, budget);
    const midSummaries = built.filter((m) => (m.content ?? '').includes('[Task mid-'));

    assert.ok(
      midSummaries.length > 0,
      `mid layer should survive a large recent layer; got ${midSummaries.length} mid summaries`,
    );
  });
});

describe('buildContext token budgets', () => {
  const savedContextLimit = process.env.MAX_CONTEXT_TOKENS;

  function restoreContextLimit(): void {
    if (savedContextLimit === undefined) {
      delete process.env.MAX_CONTEXT_TOKENS;
    } else {
      process.env.MAX_CONTEXT_TOKENS = savedContextLimit;
    }
  }

  it('caps mid summaries by mid_pct token budget', () => {
    process.env.MAX_CONTEXT_TOKENS = '30000';
    const budget = createBudgetConfig('unknown-model');
    const { mid: midBudget } = layerBudgets(budget);

    const tasks = [
      ...Array.from({ length: 10 }, (_, i) => makeTask(`mid-${i}`, 'm'.repeat(3_000))),
      makeTask('recent-only', 'r'.repeat(8_000)),
    ];
    const session: SessionFile = {
      session_id: 's1',
      tasks,
      current_messages: [{ role: 'user', content: 'current' }],
    };

    try {
      const built = buildContext(session, budget);
      const midSummaries = built.filter((m) => (m.content ?? '').includes('[Task mid-'));
      const midTokens = estimateTokens(midSummaries);

      assert.ok(midSummaries.length < 10);
      assert.ok(midTokens <= midBudget);
    } finally {
      restoreContextLimit();
    }
  });

  it('rolls mid overflow into early aggregate when early_pct allows', () => {
    process.env.MAX_CONTEXT_TOKENS = '30000';
    const budget = createBudgetConfig('unknown-model');

    const tasks = [
      ...Array.from({ length: 6 }, (_, i) => makeTask(`mid-${i}`, 'm'.repeat(3_000))),
      makeTask('recent-only', 'r'.repeat(8_000)),
    ];
    const session: SessionFile = {
      session_id: 's1',
      tasks,
      current_messages: [{ role: 'user', content: 'current' }],
    };

    try {
      const built = buildContext(session, budget);
      const early = built.find((m) => (m.content ?? '').startsWith('[Earlier context]'));

      assert.ok(early, 'mid overflow should appear in early aggregate');
      assert.match(early.content ?? '', /additional tasks completed/);
    } finally {
      restoreContextLimit();
    }
  });
});

describe('buildTaskSummaryMessages', () => {
  it('tolerates missing files_touched and tools_used on legacy tasks', () => {
    const legacy = {
      task_id: 'legacy',
      user_intent: 'old session',
      user_messages: [],
      tech_concepts: [],
      pending_tasks: [],
      current_work: 'done',
    } as TaskSummaryDoc;

    const [msg] = buildTaskSummaryMessages([legacy]);
    assert.match(msg.content ?? '', /Files: \(none\)/);
    assert.match(msg.content ?? '', /Tools: \(none\)/);
  });
});