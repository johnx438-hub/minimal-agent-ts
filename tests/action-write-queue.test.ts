import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { resetActionIoMetricsForTests } from '../src/action-io-metrics.js';
import { saveAction } from '../src/action-store.js';
import {
  ActionWriteQueue,
  configureActionWriteQueue,
  flushActionWrites,
  resetActionWriteQueueForTests,
} from '../src/action-write-queue.js';
import {
  configureSpawnSemaphore,
  getSpawnSemaphore,
  resetSpawnSemaphoreForTests,
} from '../src/spawn/semaphore.js';
import type { ActionBlock } from '../src/types.js';
import { setWorkspaceRoot } from '../src/workspace.js';

function sampleBlock(id: string, sessionId = 'session_q'): ActionBlock {
  return {
    action_id: id,
    task_id: 'task_001',
    session_id: sessionId,
    turn_number: 1,
    tool_name: 'read_file',
    args_json: '{"path":"a.ts"}',
    result_text: `body-${id}`,
    result_hash: 'abc',
    byte_size: 8,
    line_count: 1,
    pointerized: false,
    files_touched: ['a.ts'],
    timestamp: Date.now(),
    token_cost: 2,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('ActionWriteQueue', () => {
  it('flushes enqueued blocks asynchronously', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ma-action-q-'));
    setWorkspaceRoot(dir);
    resetActionWriteQueueForTests();
    resetActionIoMetricsForTests();

    configureActionWriteQueue({ sync: false, drainIntervalMs: 5, maxBatch: 4 });

    saveAction(sampleBlock('action_async_1'));
    saveAction(sampleBlock('action_async_2'));

    const path1 = join(dir, '.sessions', 'actions', 'action_async_1.json');
    assert.equal(existsSync(path1), false);

    await flushActionWrites();

    assert.ok(existsSync(path1));
    const parsed = JSON.parse(readFileSync(path1, 'utf8')) as ActionBlock;
    assert.equal(parsed.result_text, 'body-action_async_1');
    resetActionWriteQueueForTests();
  });

  it('flushSync drains pending blocks', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ma-action-sync-'));
    setWorkspaceRoot(dir);

    const queue = new ActionWriteQueue({ sync: false, drainIntervalMs: 60_000 });
    queue.enqueue(sampleBlock('action_sync_1'));

    const info = queue.flushSync();
    assert.equal(info.count, 1);
    assert.equal(info.pending, 0);
    assert.ok(
      existsSync(join(dir, '.sessions', 'actions', 'action_sync_1.json')),
    );
    queue.dispose();
    resetActionWriteQueueForTests();
  });

  it('pauses background drain while spawn is active', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ma-action-spawn-'));
    setWorkspaceRoot(dir);
    resetSpawnSemaphoreForTests();
    resetActionWriteQueueForTests();
    configureSpawnSemaphore(1);

    const queue = new ActionWriteQueue({
      sync: false,
      drainIntervalMs: 10,
      maxBatch: 4,
      pauseDuringSpawn: true,
    });
    queue.setActiveSessionId('session_q');

    const release = await getSpawnSemaphore().acquire();
    queue.enqueue(sampleBlock('action_paused_1'));

    await sleep(40);
    assert.equal(
      existsSync(join(dir, '.sessions', 'actions', 'action_paused_1.json')),
      false,
    );

    release();
    await sleep(40);
    assert.ok(
      existsSync(join(dir, '.sessions', 'actions', 'action_paused_1.json')),
    );

    queue.dispose();
    resetActionWriteQueueForTests();
    resetSpawnSemaphoreForTests();
  });

  it('prioritizes active session blocks in a batch', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ma-action-priority-'));
    setWorkspaceRoot(dir);

    const queue = new ActionWriteQueue({
      sync: false,
      drainIntervalMs: 60_000,
      maxBatch: 2,
      pauseDuringSpawn: false,
    });
    queue.setActiveSessionId('session_main');

    queue.enqueue(sampleBlock('bg_1', 'session_other'));
    queue.enqueue(sampleBlock('fg_1', 'session_main'));
    queue.enqueue(sampleBlock('fg_2', 'session_main'));

    await queue.flush();

    const readIds = ['fg_1', 'fg_2', 'bg_1'].filter((id) =>
      existsSync(join(dir, '.sessions', 'actions', `${id}.json`)),
    );
    assert.deepEqual(readIds, ['fg_1', 'fg_2', 'bg_1']);

    queue.dispose();
    resetActionWriteQueueForTests();
  });
});