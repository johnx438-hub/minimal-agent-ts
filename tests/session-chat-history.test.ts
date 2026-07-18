import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildSessionChatHistory } from '../src/session-chat-history.js';
import type { SessionFile } from '../src/types.js';

describe('session chat history', () => {
  it('includes in-flight current_messages', () => {
    const session = {
      session_id: 'session_test',
      user_id: 'u',
      created_at: 1,
      tasks: [],
      current_messages: [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'hi there' },
      ],
    } as SessionFile;
    const msgs = buildSessionChatHistory(session);
    assert.equal(msgs.length, 2);
    assert.equal(msgs[0]!.role, 'user');
    assert.equal(msgs[0]!.source, 'in_flight');
    assert.equal(msgs[1]!.role, 'assistant');
    assert.equal(msgs[1]!.content, 'hi there');
  });
});
