import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildContext,
  CHARS_PER_TOKEN,
  createBudgetConfig,
  estimateTokens,
  layerBudgets,
  resumeHistoryBudget,
  selectHistoryWithinBudget,
} from '../src/context/budget.js';
import { buildTaskSummaryMessages } from '../src/context/heavy-compression.js';
import type { ChatMessage, SessionFile, TaskSummaryDoc } from '../src/types.js';

function fillerTokens(targetTokens: number): string {
  return 'x'.repeat(Math.ceil(targetTokens * CHARS_PER_TOKEN) + 50);
}

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

describe('selectHistoryWithinBudget', () => {
  it('keeps full history when under budget', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'a', turn: 1 },
      { role: 'assistant', content: 'b', turn: 1 },
      { role: 'user', content: 'c', turn: 2 },
    ];
    const selected = selectHistoryWithinBudget(messages, 10_000);
    assert.equal(selected.length, 3);
    assert.equal(selected[0], messages[0]);
  });

  it('skips compacted messages without mutating them', () => {
    const compacted: ChatMessage = {
      role: 'tool',
      content: '[compacted tool]',
      compacted_at: 1,
      turn: 1,
    };
    const live: ChatMessage = { role: 'user', content: 'live', turn: 2 };
    const selected = selectHistoryWithinBudget([compacted, live], 10_000);
    assert.deepEqual(selected, [live]);
    assert.equal(compacted.compacted_at, 1);
  });

  it('prefers newest messages under a tight budget', () => {
    const messages: ChatMessage[] = [
      { role: 'user', content: fillerTokens(5_000), turn: 1 },
      { role: 'user', content: fillerTokens(5_000), turn: 2 },
      { role: 'user', content: 'latest-only', turn: 3 },
    ];
    const selected = selectHistoryWithinBudget(messages, 2_000);
    assert.ok(selected.length >= 1);
    assert.equal(selected[selected.length - 1]?.content, 'latest-only');
    assert.ok(estimateTokens(selected) <= 2_000 + 50);
  });

  it('preserves pointer card text and metadata verbatim', () => {
    const card =
      '[action:action_ptr_1]\n' +
      'tool=read_file path=a.ts lines=1-10 chars=100 sha256=abc\n' +
      'summary=export function foo\n' +
      'preview:\n' +
      '  line1\n' +
      'recall=recall_query(action_id="action_ptr_1")';
    const pointerMsg: ChatMessage = {
      role: 'tool',
      content: card,
      action_id: 'action_ptr_1',
      pointerized: true,
      tool_call_id: 'tc1',
      turn: 5,
    };
    const assistant: ChatMessage = {
      role: 'assistant',
      content: null,
      turn: 5,
      tool_calls: [
        {
          id: 'tc1',
          type: 'function',
          function: { name: 'read_file', arguments: '{}' },
        },
      ],
    };
    const oldBulk: ChatMessage = {
      role: 'user',
      content: fillerTokens(80_000),
      turn: 1,
    };
    const selected = selectHistoryWithinBudget(
      [oldBulk, assistant, pointerMsg, { role: 'user', content: 'continue', turn: 6 }],
      15_000,
    );

    const kept = selected.find((m) => m.pointerized);
    assert.ok(kept, 'pointerized tool should remain in window when recent');
    assert.equal(kept.content, card);
    assert.equal(kept.action_id, 'action_ptr_1');
    assert.equal(kept.pointerized, true);
    assert.match(kept.content ?? '', /^\[action:action_ptr_1\]/);
  });
});

describe('buildContext live history trim', () => {
  it('does not dump entire current_messages on large sessions', () => {
    process.env.MAX_CONTEXT_TOKENS = '50000';
    const budget = createBudgetConfig('unknown-model');
    const tasks = Array.from({ length: 8 }, (_, i) => makeTask(`t-${i}`));
    const current_messages: ChatMessage[] = [];
    for (let i = 0; i < 40; i++) {
      current_messages.push({
        role: 'user',
        content: fillerTokens(3_000),
        turn: i,
      });
      current_messages.push({
        role: 'assistant',
        content: fillerTokens(3_000),
        turn: i,
      });
    }
    current_messages.push({ role: 'user', content: 'tail-user', turn: 99 });

    const session: SessionFile = {
      session_id: 's-large',
      tasks,
      current_messages,
    };

    try {
      const built = buildContext(session, budget);
      const historyBudget = resumeHistoryBudget(
        budget,
        estimateTokens(built.filter((m) => (m.content ?? '').startsWith('[') && (
          (m.content ?? '').startsWith('[Task ') ||
          (m.content ?? '').startsWith('[Earlier ') ||
          (m.content ?? '').startsWith('[Recent task ')
        ))),
      );
      // Built payload must be smaller than raw dump of current_messages alone.
      assert.ok(
        estimateTokens(built) < estimateTokens(current_messages),
        'buildContext should trim live history vs full dump',
      );
      assert.ok(built.some((m) => m.content === 'tail-user'));
      assert.ok(historyBudget >= 4_000);
    } finally {
      delete process.env.MAX_CONTEXT_TOKENS;
    }
  });

  it('never rewrites existing pointer cards when trimming history', () => {
    process.env.MAX_CONTEXT_TOKENS = '80000';
    const budget = createBudgetConfig('unknown-model');
    const card =
      '[action:action_keep]\n' +
      'tool=read_file path=b.ts lines=1-5 chars=50 sha256=def\n' +
      'summary=kept card\n' +
      'recall=recall_query(action_id="action_keep")';
    const pointerMsg: ChatMessage = {
      role: 'tool',
      content: card,
      action_id: 'action_keep',
      pointerized: true,
      tool_call_id: 'tc_keep',
      turn: 50,
    };
    const current_messages: ChatMessage[] = [
      { role: 'user', content: fillerTokens(20_000), turn: 1 },
      {
        role: 'assistant',
        content: null,
        turn: 50,
        tool_calls: [
          {
            id: 'tc_keep',
            type: 'function',
            function: { name: 'read_file', arguments: '{}' },
          },
        ],
      },
      pointerMsg,
      { role: 'user', content: 'resume me', turn: 51 },
    ];
    const session: SessionFile = {
      session_id: 's-ptr',
      tasks: [makeTask('only')],
      current_messages,
    };

    try {
      const built = buildContext(session, budget);
      const kept = built.find((m) => m.action_id === 'action_keep');
      assert.ok(kept);
      assert.equal(kept.content, card);
      assert.equal(kept.pointerized, true);
      assert.match(kept.content ?? '', /^\[action:action_keep\]/);
      // Original session object must not be mutated.
      assert.equal(pointerMsg.content, card);
      assert.equal(session.current_messages.length, 4);
    } finally {
      delete process.env.MAX_CONTEXT_TOKENS;
    }
  });
});