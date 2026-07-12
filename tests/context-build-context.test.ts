import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildContext, createBudgetConfig } from '../src/context/budget.js';
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