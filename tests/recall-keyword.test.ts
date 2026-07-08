import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { buildActionBlock, saveAction } from '../src/action-store.js';
import {
  configureActionWriteQueue,
  resetActionWriteQueueForTests,
} from '../src/action-write-queue.js';
import { recallQuery } from '../src/recall.js';
import type { AgentConfig } from '../src/types.js';
import { setWorkspaceRoot } from '../src/workspace.js';

function setup(): { config: AgentConfig } {
  const dir = mkdtempSync(join(tmpdir(), 'recall-kw-'));
  setWorkspaceRoot(dir);
  resetActionWriteQueueForTests();
  configureActionWriteQueue({ sync: true });

  const config: AgentConfig = {
    apiKey: 'k',
    baseUrl: 'http://localhost',
    model: 'm',
    maxTurns: 0,
    cwd: dir,
    allowShell: false,
    allowWeb: false,
    sessionId: 'session_recall',
  };
  return { config };
}

describe('recall_query keyword search', () => {
  it('loads by action_id', async () => {
    const { config } = setup();
    saveAction(
      buildActionBlock({
        action_id: 'action_exact',
        task_id: 'task_1',
        session_id: 'session_recall',
        turn_number: 1,
        tool_name: 'read_file',
        args_json: '{"path":"a.ts"}',
        result_text: 'alpha content',
      }),
    );

    const result = await recallQuery({ action_id: 'action_exact' }, config);
    assert.equal(result.matched, true);
    assert.match(result.content, /alpha content/);
  });

  it('finds action by keyword in cold storage', async () => {
    const { config } = setup();
    saveAction(
      buildActionBlock({
        action_id: 'action_old',
        task_id: 'task_1',
        session_id: 'session_recall',
        turn_number: 1,
        tool_name: 'grep_search',
        args_json: '{"pattern":"foo"}',
        result_text: 'unrelated',
      }),
    );
    saveAction(
      buildActionBlock({
        action_id: 'action_mask',
        task_id: 'task_2',
        session_id: 'session_recall',
        turn_number: 2,
        tool_name: 'write_file',
        args_json: '{"path":"game.html"}',
        result_text: 'mask-image: crossfade timeline scene',
      }),
    );

    const result = await recallQuery({ query: 'mask-image' }, config);
    assert.equal(result.matched, true);
    assert.equal(result.action_id, 'action_mask');
  });

  it('filters by tool: prefix', async () => {
    const { config } = setup();
    saveAction(
      buildActionBlock({
        action_id: 'action_shell',
        task_id: 'task_1',
        session_id: 'session_recall',
        turn_number: 1,
        tool_name: 'run_shell',
        args_json: '{"command":"npm test"}',
        result_text: 'mask-image build passed',
      }),
    );
    saveAction(
      buildActionBlock({
        action_id: 'action_write',
        task_id: 'task_2',
        session_id: 'session_recall',
        turn_number: 2,
        tool_name: 'write_file',
        args_json: '{"path":"x.html"}',
        result_text: 'other mask-image note',
      }),
    );

    const result = await recallQuery({ query: 'tool:run_shell mask-image' }, config);
    assert.equal(result.matched, true);
    assert.equal(result.action_id, 'action_shell');
  });

  it('scopes keyword search to session', async () => {
    const { config } = setup();
    saveAction(
      buildActionBlock({
        action_id: 'action_other_session',
        task_id: 'task_x',
        session_id: 'other_session',
        turn_number: 1,
        tool_name: 'read_file',
        args_json: '{}',
        result_text: 'unique-token-xyz',
      }),
    );

    const result = await recallQuery({ query: 'unique-token-xyz' }, config);
    assert.equal(result.matched, false);
  });
});