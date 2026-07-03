import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildSessionOverview,
  formatSessionPickerDescription,
  lastTaskIntentPreview,
  lastUserMessagePreview,
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

describe('formatSessionPickerDescription', () => {
  it('includes intent line in description', () => {
    const meta: SessionMeta = {
      session_id: 'session_test',
      user_id: 'user_default',
      created_at: 1,
      updated_at: 2,
      task_count: 2,
      path: '/tmp/x.json',
      last_user_preview: 'fix the bug',
      last_task_intent: 'add tests',
    };
    const desc = formatSessionPickerDescription(meta);
    assert.match(desc, /fix the bug/);
    assert.match(desc, /intent: add tests/);
    assert.match(desc, /tasks=2/);
  });
});

describe('buildSessionOverview', () => {
  it('lists tasks newest first for detail overlay', () => {
    const session: SessionFile = {
      session_id: 's1',
      user_id: 'u',
      created_at: 100,
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