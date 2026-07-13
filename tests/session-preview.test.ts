import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildSessionOverview,
  formatSessionPickerDescription,
  formatSessionPickerLabel,
  lastTaskIntentPreview,
  lastTaskSummaryPreview,
  lastUserMessagePreview,
  normalizeSessionNote,
  shortSessionId,
} from '../src/session.js';
import type { SessionFile, SessionMeta } from '../src/types.js';

describe('lastUserMessagePreview', () => {
  it('prefers the latest in-flight user message', () => {
    const session: Pick<SessionFile, 'current_messages' | 'tasks'> = {
      tasks: [
        {
          task_id: 't1',
          session_id: 's1',
          turn_range: [1, 2],
          action_count: 0,
          user_intent: 'old task intent',
          user_messages: ['old task message'],
          files_touched: [],
          tech_concepts: [],
          tools_used: [],
          pending_tasks: [],
          current_work: '',
        },
      ],
      current_messages: [
        { role: 'user', content: 'latest user line' },
        { role: 'assistant', content: 'reply' },
      ],
    };
    assert.equal(lastUserMessagePreview(session), 'latest user line');
  });

  it('falls back to the last completed task user message', () => {
    const session: Pick<SessionFile, 'current_messages' | 'tasks'> = {
      current_messages: [],
      tasks: [
        {
          task_id: 't1',
          session_id: 's1',
          turn_range: [1, 2],
          action_count: 0,
          user_intent: 'first intent',
          user_messages: ['first message', 'second message'],
          files_touched: [],
          tech_concepts: [],
          tools_used: [],
          pending_tasks: [],
          current_work: '',
        },
      ],
    };
    assert.equal(lastUserMessagePreview(session), 'second message');
  });

  it('extracts last task user_intent', () => {
    const session: Pick<SessionFile, 'tasks'> = {
      tasks: [
        {
          task_id: 't1',
          session_id: 's1',
          turn_range: [1, 2],
          action_count: 0,
          user_intent: 'older intent',
          user_messages: [],
          files_touched: [],
          tech_concepts: [],
          tools_used: [],
          pending_tasks: [],
          current_work: '',
        },
        {
          task_id: 't2',
          session_id: 's1',
          turn_range: [3, 4],
          action_count: 0,
          user_intent: 'latest task goal',
          user_messages: [],
          files_touched: [],
          tech_concepts: [],
          tools_used: [],
          pending_tasks: [],
          current_work: '',
        },
      ],
    };
    assert.equal(lastTaskIntentPreview(session), 'latest task goal');
  });
});

describe('lastTaskSummaryPreview', () => {
  it('prefers current_work over user_intent for completed tasks', () => {
    const session: Pick<SessionFile, 'current_messages' | 'tasks'> = {
      current_messages: [],
      tasks: [
        {
          task_id: 't1',
          session_id: 's1',
          turn_range: [1, 2],
          action_count: 1,
          user_intent: 'raw user ask',
          user_messages: ['raw user ask'],
          files_touched: ['src/a.ts'],
          tech_concepts: [],
          tools_used: [],
          pending_tasks: [],
          current_work: 'Implemented allowlist shell policy',
        },
      ],
    };
    assert.equal(lastTaskSummaryPreview(session), 'Implemented allowlist shell policy');
  });

  it('uses in-flight user message when present', () => {
    const session: Pick<SessionFile, 'current_messages' | 'tasks'> = {
      current_messages: [{ role: 'user', content: 'still working on X' }],
      tasks: [
        {
          task_id: 't1',
          session_id: 's1',
          turn_range: [1, 2],
          action_count: 0,
          user_intent: 'old',
          user_messages: ['old'],
          files_touched: [],
          tech_concepts: [],
          tools_used: [],
          pending_tasks: [],
          current_work: 'old work',
        },
      ],
    };
    assert.equal(lastTaskSummaryPreview(session), 'still working on X');
  });
});

describe('formatSessionPickerDescription', () => {
  it('shows summary, files, task count, and note star', () => {
    const meta: SessionMeta = {
      session_id: 'session_test',
      user_id: 'user_default',
      created_at: 1,
      updated_at: 2,
      task_count: 2,
      path: '/tmp/x.json',
      last_user_preview: 'fix the bug',
      last_task_intent: 'add tests',
      last_task_summary: 'Added unit tests for shell policy',
      last_files_touched: ['shell.ts', 'agent.json'],
      note: 'C5 work',
      has_in_flight: false,
    };
    const desc = formatSessionPickerDescription(meta);
    assert.match(desc, /Added unit tests for shell policy/);
    assert.match(desc, /files: shell\.ts, agent\.json/);
    assert.match(desc, /2t/);
    assert.match(desc, /★/);
  });

  it('marks in-flight summaries', () => {
    const meta: SessionMeta = {
      session_id: 's',
      user_id: 'u',
      created_at: 1,
      task_count: 0,
      path: '/tmp/x.json',
      last_task_summary: 'half done',
      has_in_flight: true,
    };
    assert.match(formatSessionPickerDescription(meta), /\[…\] half done/);
  });
});

describe('formatSessionPickerLabel', () => {
  it('prefers note over short id', () => {
    const meta: SessionMeta = {
      session_id: 'session_20260713104200',
      user_id: 'u',
      created_at: Date.UTC(2026, 6, 13, 10, 42),
      updated_at: Date.UTC(2026, 6, 13, 10, 42),
      task_count: 1,
      path: '/tmp/x.json',
      note: 'C5 shell policy',
    };
    const label = formatSessionPickerLabel(meta);
    assert.match(label, /C5 shell policy/);
    assert.doesNotMatch(label, /104200/);
  });

  it('uses short id when no note', () => {
    assert.equal(shortSessionId('session_20260713104200'), '104200');
    const meta: SessionMeta = {
      session_id: 'session_20260713104200',
      user_id: 'u',
      created_at: Date.UTC(2026, 6, 13, 10, 42),
      updated_at: Date.UTC(2026, 6, 13, 10, 42),
      task_count: 0,
      path: '/tmp/x.json',
    };
    assert.match(formatSessionPickerLabel(meta, { currentId: meta.session_id }), /●/);
    assert.match(formatSessionPickerLabel(meta), /104200/);
  });
});

describe('normalizeSessionNote', () => {
  it('trims, collapses space, clears empty', () => {
    assert.equal(normalizeSessionNote('  hi   there  '), 'hi there');
    assert.equal(normalizeSessionNote('   '), undefined);
    assert.equal(normalizeSessionNote(null), undefined);
  });
});

describe('buildSessionOverview', () => {
  it('lists tasks newest first for detail overlay', () => {
    const session: SessionFile = {
      session_id: 's1',
      user_id: 'u',
      created_at: 100,
      note: 'my note',
      tasks: [
        {
          task_id: 't1',
          session_id: 's1',
          turn_range: [1, 2],
          action_count: 1,
          user_intent: 'first',
          user_messages: ['first'],
          files_touched: ['a.ts'],
          tech_concepts: [],
          tools_used: [],
          pending_tasks: [],
          current_work: '',
        },
        {
          task_id: 't2',
          session_id: 's1',
          turn_range: [3, 4],
          action_count: 1,
          user_intent: 'second',
          user_messages: ['second'],
          files_touched: ['b.ts'],
          tech_concepts: [],
          tools_used: [],
          pending_tasks: [],
          current_work: '',
        },
      ],
      current_messages: [{ role: 'user', content: 'in flight' }],
    };
    const overview = buildSessionOverview(session);
    assert.equal(overview.tasks[0]?.task_id, 't2');
    assert.equal(overview.has_in_flight, true);
    assert.match(overview.in_flight_preview, /in flight/);
    assert.equal(overview.note, 'my note');
  });
});

describe('lastUserMessagePreview clips', () => {
  it('clips long previews to one line', () => {
    const long = 'word '.repeat(40).trim();
    const session: Pick<SessionFile, 'current_messages' | 'tasks'> = {
      current_messages: [{ role: 'user', content: long }],
      tasks: [],
    };
    const preview = lastUserMessagePreview(session);
    assert.ok(preview.endsWith('…'));
    assert.ok(preview.length <= 72);
  });
});
