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

  it('strips pending_tasks JSON and exposes meta', () => {
    const session = {
      session_id: 'session_test',
      user_id: 'u',
      created_at: 1,
      tasks: [],
      current_messages: [
        {
          role: 'assistant',
          content:
            'Done with the fix.\n\n{"pending_tasks": ["add tests"], "current_work": "patched foo"}',
        },
      ],
    } as SessionFile;
    const msgs = buildSessionChatHistory(session);
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0]!.content, 'Done with the fix.');
    assert.deepEqual(msgs[0]!.meta?.pending_tasks, ['add tests']);
    assert.equal(msgs[0]!.meta?.current_work, 'patched foo');
  });

  it('unwraps Working directory / Task envelope for display', () => {
    const session = {
      session_id: 'session_test',
      user_id: 'u',
      created_at: 1,
      tasks: [],
      current_messages: [
        {
          role: 'user',
          content:
            'Working directory: /home/archer/zerostack-analysis/minimal-agent-ts\n\nTask:\nfix the login bug',
        },
      ],
    } as SessionFile;
    const msgs = buildSessionChatHistory(session);
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0]!.role, 'user');
    assert.equal(msgs[0]!.content, 'fix the login bug');
    assert.equal(msgs[0]!.view_kind, 'chat');
  });

  it('projects synthetic system_event auto_run prompts as system_ui', () => {
    const body = [
      'Working directory: /tmp/proj\n\nTask:',
      '<system_event not_user_message="true">',
      '[system_event · not a user message]',
      'kind: job_complete',
      'job_id: job_abc',
      '</system_event>',
      '',
      'You are the main agent. This is NOT a human user message.',
      'Review the job/workflow result: accept, suggest follow-ups, or ask the user what to do next.',
      'Do not re-arm a workflow unless the user already asked.',
      'Prefer not to fan out many new background jobs without confirmation.',
    ].join('\n');
    const session = {
      session_id: 'session_test',
      user_id: 'u',
      created_at: 1,
      tasks: [],
      current_messages: [{ role: 'user', content: body }],
    } as SessionFile;
    const msgs = buildSessionChatHistory(session);
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0]!.role, 'system');
    assert.equal(msgs[0]!.view_kind, 'system_ui');
    assert.match(msgs[0]!.content, /job_complete/);
    assert.doesNotMatch(msgs[0]!.content, /Working directory/);
  });
});
