import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  appendCompressionNotice,
  runCompressionEvent,
} from '../src/context-policy.js';
import {
  CHARS_PER_TOKEN,
  createBudgetConfig,
  heavyCompressionThreshold,
} from '../src/context/budget.js';
import {
  formatSkillsInvokedForNotice,
  isSuccessfulSkillInvokeOutput,
  parseInvokeSkillArgs,
  recordSessionSkillInvoked,
} from '../src/session-skills.js';
import type { SessionFile } from '../src/types.js';

const budget = createBudgetConfig('deepseek/deepseek-chat');

function fillerTokens(targetTokens: number): string {
  return 'x'.repeat(Math.ceil(targetTokens * CHARS_PER_TOKEN) + 50);
}

describe('session-skills', () => {
  it('parseInvokeSkillArgs reads name and query', () => {
    assert.deepEqual(parseInvokeSkillArgs('{"name":"office-layout","query":"table"}'), {
      name: 'office-layout',
      query: 'table',
    });
    assert.equal(parseInvokeSkillArgs('{"name":"  x  "}').name, 'x');
    assert.equal(parseInvokeSkillArgs('not-json').name, '');
  });

  it('isSuccessfulSkillInvokeOutput filters list/error', () => {
    assert.equal(isSuccessfulSkillInvokeOutput('error: unknown skill'), false);
    assert.equal(isSuccessfulSkillInvokeOutput('Available skills:\n- a'), false);
    assert.equal(
      isSuccessfulSkillInvokeOutput('# Skill: office-layout\n\n## Guidance\nHi'),
      true,
    );
  });

  it('recordSessionSkillInvoked upserts by name', () => {
    const session: SessionFile = {
      session_id: 's1',
      user_id: 'u',
      created_at: 1,
      tasks: [],
      current_messages: [],
    };
    recordSessionSkillInvoked(session, {
      name: 'office-layout',
      action_id: 'action_a',
      turn: 1,
      at: 100,
    });
    recordSessionSkillInvoked(session, {
      name: 'context-design',
      action_id: 'action_b',
      turn: 2,
      at: 200,
    });
    recordSessionSkillInvoked(session, {
      name: 'office-layout',
      action_id: 'action_c',
      turn: 3,
      at: 300,
    });
    assert.equal(session.skills_invoked?.length, 2);
    const office = session.skills_invoked!.find((s) => s.name === 'office-layout');
    assert.equal(office?.action_id, 'action_c');
    assert.equal(office?.turn, 3);
  });

  it('formatSkillsInvokedForNotice includes action ids', () => {
    const line = formatSkillsInvokedForNotice([
      { name: 'office-layout', action_id: 'action_x', at: 1 },
    ]);
    assert.ok(line);
    assert.match(line!, /office-layout \(action_x\)/);
    assert.match(line!, /recall_query/);
  });

  it('appendCompressionNotice embeds skills_invoked line', () => {
    const msg = appendCompressionNotice(['ts'], [
      { name: 'office-layout', action_id: 'action_1', at: 1 },
    ]);
    assert.match(msg.content ?? '', /Topics discussed: ts/);
    assert.match(msg.content ?? '', /Skills this session: office-layout \(action_1\)/);
  });

  it('runCompressionEvent first notice includes session skills_invoked', () => {
    const session: SessionFile = {
      session_id: 's1',
      user_id: 'u',
      created_at: 1,
      tasks: [],
      current_messages: [],
      skills_invoked: [
        { name: 'office-layout', action_id: 'action_z9', at: Date.now() },
      ],
    };
    const userTask = { role: 'user' as const, content: 'write report' };
    const messages = [
      { role: 'system' as const, content: 'sys' },
      {
        role: 'user' as const,
        content: fillerTokens(heavyCompressionThreshold(budget, false) + 1000),
      },
    ];
    const ok = runCompressionEvent({
      messages,
      session,
      currentTurn: 4,
      budget,
      userTask,
    });
    assert.equal(ok, true);
    const notice = messages.find((m) => (m.content ?? '').includes('Skills this session'));
    assert.ok(notice);
    assert.match(notice!.content ?? '', /office-layout \(action_z9\)/);
  });
});
