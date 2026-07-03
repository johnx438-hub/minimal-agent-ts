import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { lastUserMessagePreview } from '../src/session.js';
import type { SessionFile } from '../src/types.js';

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