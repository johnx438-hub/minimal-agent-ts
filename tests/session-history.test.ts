import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { saveAction } from '../src/action-store.js';
import {
  HISTORY_IN_FLIGHT_TASK_ID,
  listHistoryLines,
  listHistoryTasks,
} from '../src/session-history.js';
import type { ActionBlock, SessionFile } from '../src/types.js';
import { setWorkspaceRoot } from '../src/workspace.js';

function sampleSession(): SessionFile {
  return {
    session_id: 'session_test',
    user_id: 'user_default',
    created_at: 100,
    tasks: [
      {
        task_id: 'task_001',
        session_id: 'session_test',
        turn_range: [1, 4],
        action_count: 1,
        user_intent: 'fix bug',
        user_messages: ['fix bug', 'run tests'],
        files_touched: ['src/a.ts'],
        tech_concepts: ['TypeScript'],
        tools_used: ['edit_file'],
        pending_tasks: [],
        current_work: 'edited a.ts',
      },
    ],
    current_messages: [
      { role: 'user', content: 'continue work' },
      {
        role: 'tool',
        content: '[action:action_001_1]\ntool=run_shell',
        action_id: 'action_001_1',
      },
    ],
  };
}

describe('listHistoryTasks', () => {
  it('lists in-flight first then completed tasks newest-first', () => {
    const tasks = listHistoryTasks(sampleSession());
    assert.equal(tasks[0]?.taskId, HISTORY_IN_FLIGHT_TASK_ID);
    assert.equal(tasks[1]?.taskId, 'task_001');
  });
});

describe('listHistoryLines', () => {
  it('includes user messages and actions for completed tasks', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ma-hist-'));
    setWorkspaceRoot(dir);
    mkdirSync(join(dir, '.sessions', 'actions'), { recursive: true });

    const block: ActionBlock = {
      action_id: 'action_hist_1',
      task_id: 'task_001',
      session_id: 'session_test',
      turn_number: 3,
      tool_name: 'edit_file',
      args_json: '{"path":"src/a.ts"}',
      result_text: 'ok: edited',
      result_hash: 'abc',
      byte_size: 11,
      line_count: 1,
      pointerized: true,
      files_touched: ['src/a.ts'],
      timestamp: 200,
      token_cost: 2,
      preview_summary: 'edited a.ts',
    };
    saveAction(block);

    const session = sampleSession();
    const lines = listHistoryLines(session, 'task_001');
    assert.ok(lines.some((l) => l.kind === 'user' && l.label.includes('fix bug')));
    assert.ok(lines.some((l) => l.kind === 'action' && l.actionId === 'action_hist_1'));
  });

  it('resolves in-flight tool messages to actions', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ma-hist-flight-'));
    setWorkspaceRoot(dir);
    mkdirSync(join(dir, '.sessions', 'actions'), { recursive: true });

    saveAction({
      action_id: 'action_001_1',
      task_id: 'task_002',
      session_id: 'session_test',
      turn_number: 2,
      tool_name: 'run_shell',
      args_json: '{"command":"npm test"}',
      result_text: 'all passed',
      result_hash: 'def',
      byte_size: 10,
      line_count: 1,
      pointerized: true,
      files_touched: [],
      timestamp: 300,
      token_cost: 2,
    });

    const lines = listHistoryLines(sampleSession(), HISTORY_IN_FLIGHT_TASK_ID);
    assert.ok(lines.some((l) => l.kind === 'user' && l.label.includes('continue work')));
    assert.ok(lines.some((l) => l.actionId === 'action_001_1'));
  });
});