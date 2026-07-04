import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  buildActionBlock,
  extractPathsFromArgs,
  hashResult,
  listActions,
  loadAction,
  saveAction,
} from '../src/action-store.js';
import {
  configureActionWriteQueue,
  resetActionWriteQueueForTests,
} from '../src/action-write-queue.js';
import { setWorkspaceRoot } from '../src/workspace.js';

function setupWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ma-action-store-'));
  setWorkspaceRoot(dir);
  resetActionWriteQueueForTests();
  configureActionWriteQueue({ sync: true });
  return dir;
}

describe('action-store helpers', () => {
  it('hashes results deterministically with 16 hex chars', () => {
    const a = hashResult('same text');
    const b = hashResult('same text');
    const c = hashResult('other text');

    assert.equal(a, b);
    assert.notEqual(a, c);
    assert.match(a, /^[0-9a-f]{16}$/);
  });

  it('extracts path from args_json', () => {
    assert.deepEqual(extractPathsFromArgs('{"path":"src/a.ts"}'), ['src/a.ts']);
    assert.deepEqual(extractPathsFromArgs('{"url":"https://x"}'), []);
    assert.deepEqual(extractPathsFromArgs('not-json'), []);
  });

  it('builds action blocks with derived fields', () => {
    const resultText = 'line1\nline2\nline3';
    const block = buildActionBlock({
      action_id: 'action_build_1',
      task_id: 'task_build',
      session_id: 'session_build',
      turn_number: 2,
      tool_name: 'read_file',
      args_json: '{"path":"b.ts"}',
      result_text: resultText,
    });

    assert.equal(block.result_hash, hashResult(resultText));
    assert.equal(block.byte_size, Buffer.byteLength(resultText, 'utf8'));
    assert.equal(block.line_count, 3);
    assert.deepEqual(block.files_touched, ['b.ts']);
    assert.equal(block.pointerized, false);
    assert.ok(block.timestamp > 0);
    assert.equal(block.token_cost, Math.ceil(resultText.split(/\s+/).filter(Boolean).length * 1.3));
  });
});

describe('action-store persistence', () => {
  it('round-trips saveAction and loadAction', () => {
    const dir = setupWorkspace();
    const block = buildActionBlock({
      action_id: 'action_roundtrip',
      task_id: 'task_rt',
      session_id: 'session_rt',
      turn_number: 1,
      tool_name: 'grep_search',
      args_json: '{"pattern":"foo"}',
      result_text: 'match line',
    });

    saveAction(block);

    const path = join(dir, '.sessions', 'actions', 'action_roundtrip.json');
    assert.ok(existsSync(path));

    const loaded = loadAction('action_roundtrip');
    assert.ok(loaded);
    assert.equal(loaded.action_id, block.action_id);
    assert.equal(loaded.result_text, block.result_text);
    assert.equal(loaded.result_hash, block.result_hash);
  });

  it('returns null for missing or corrupt action files', () => {
    const dir = setupWorkspace();
    assert.equal(loadAction('action_missing'), null);

    const actionsDir = join(dir, '.sessions', 'actions');
    mkdirSync(actionsDir, { recursive: true });
    const corruptPath = join(actionsDir, 'action_bad.json');
    writeFileSync(corruptPath, '{not json', 'utf8');
    assert.equal(loadAction('action_bad'), null);
  });

  it('lists actions with optional session/task filters newest first', () => {
    setupWorkspace();

    const older = buildActionBlock({
      action_id: 'action_old',
      task_id: 'task_a',
      session_id: 'session_a',
      turn_number: 1,
      tool_name: 'read_file',
      args_json: '{"path":"a.ts"}',
      result_text: 'old',
    });
    const newer = buildActionBlock({
      action_id: 'action_new',
      task_id: 'task_b',
      session_id: 'session_b',
      turn_number: 2,
      tool_name: 'read_file',
      args_json: '{"path":"b.ts"}',
      result_text: 'new',
    });

    older.timestamp = 1_000;
    newer.timestamp = 2_000;
    saveAction(older);
    saveAction(newer);

    assert.equal(listActions().length, 2);
    assert.equal(listActions('session_a').length, 1);
    assert.equal(listActions(undefined, 'task_b').length, 1);
    assert.equal(listActions('session_b', 'task_b').length, 1);
    assert.equal(listActions('session_a', 'task_b').length, 0);

    const listed = listActions();
    assert.equal(listed[0]?.action_id, 'action_new');
    assert.equal(listed[1]?.action_id, 'action_old');
  });
});