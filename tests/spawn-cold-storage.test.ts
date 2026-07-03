import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { actionFilePathForBlock } from '../src/action-paths.js';
import { buildActionBlock, loadAction, listSpawnActions, saveAction } from '../src/action-store.js';
import {
  configureActionWriteQueue,
  flushActionWrites,
  resetActionWriteQueueForTests,
} from '../src/action-write-queue.js';
import { listLogLines, listLogTasks } from '../src/session-log.js';
import {
  appendSpawnRunRecord,
  buildSpawnSessionId,
  isSpawnSessionId,
  listSpawnRunRecords,
  spawnLogTaskId,
} from '../src/spawn/session.js';
import type { SessionFile } from '../src/types.js';
import { setWorkspaceRoot, spawnActionsDir } from '../src/workspace.js';

describe('spawn cold storage', () => {
  it('builds virtual spawn session ids', () => {
    const id = buildSpawnSessionId('session_20260627203000');
    assert.ok(isSpawnSessionId(id));
    assert.match(id, /^spawn_/);
  });

  it('writes spawn actions under actions/spawn/<parent>/', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ma-spawn-store-'));
    setWorkspaceRoot(dir);
    resetActionWriteQueueForTests();
    configureActionWriteQueue({ sync: false, drainIntervalMs: 5 });

    const parentSessionId = 'session_parent_001';
    const spawnSessionId = buildSpawnSessionId(parentSessionId);
    const block = buildActionBlock({
      action_id: 'action_spawn_001',
      task_id: 'task_spawn_001',
      session_id: spawnSessionId,
      turn_number: 1,
      tool_name: 'read_file',
      args_json: '{"path":"a.ts"}',
      result_text: 'spawn body',
      spawn_parent_session_id: parentSessionId,
    });

    const path = actionFilePathForBlock(block);
    assert.equal(
      path,
      join(dir, '.sessions', 'actions', 'spawn', parentSessionId, 'action_spawn_001.json'),
    );

    saveAction(block);
    await flushActionWrites();

    assert.ok(existsSync(path));
    const loaded = loadAction('action_spawn_001');
    assert.equal(loaded?.session_id, spawnSessionId);
    assert.equal(loaded?.spawn_parent_session_id, parentSessionId);

    const listed = listSpawnActions(parentSessionId, spawnSessionId);
    assert.equal(listed.length, 1);
    assert.equal(listed[0]?.action_id, 'action_spawn_001');

    resetActionWriteQueueForTests();
  });

  it('lists spawn runs in /log task browser', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ma-spawn-log-'));
    setWorkspaceRoot(dir);

    const parentSessionId = 'session_parent_log';
    const spawnSessionId = buildSpawnSessionId(parentSessionId);

    appendSpawnRunRecord({
      spawn_session_id: spawnSessionId,
      parent_session_id: parentSessionId,
      preset: 'web-researcher',
      task: 'find docs',
      started_at: Date.now() - 1000,
      ended_at: Date.now(),
      ok: true,
    });

    const block = buildActionBlock({
      action_id: 'action_spawn_log_1',
      task_id: 'task_spawn_log_1',
      session_id: spawnSessionId,
      turn_number: 1,
      tool_name: 'web_fetch',
      args_json: '{"url":"https://example.com"}',
      result_text: 'page',
      spawn_parent_session_id: parentSessionId,
    });
    mkdirSync(spawnActionsDir(parentSessionId), { recursive: true });
    writeFileSync(
      join(spawnActionsDir(parentSessionId), 'action_spawn_log_1.json'),
      JSON.stringify(block, null, 2),
      'utf8',
    );

    const session: SessionFile = {
      session_id: parentSessionId,
      cwd: dir,
      created_at: Date.now(),
      current_messages: [],
      tasks: [],
    };

    const tasks = listLogTasks(session);
    const spawnTask = tasks.find((t) => t.kind === 'spawn');
    assert.ok(spawnTask);
    assert.equal(spawnTask?.taskId, spawnLogTaskId(spawnSessionId));
    assert.match(spawnTask?.label ?? '', /web-researcher/);

    const lines = listLogLines(session, spawnTask!.taskId);
    assert.ok(lines.some((line) => line.actionId === 'action_spawn_log_1'));

    assert.equal(listSpawnRunRecords(parentSessionId).length, 1);
  });
});