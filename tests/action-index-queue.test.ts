import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ActionIndexQueue,
  configureActionIndexQueue,
  enqueueActionIndex,
  flushActionIndex,
  resetActionIndexQueueForTests,
} from '../src/action-index-queue.js';
import {
  configureSpawnSemaphore,
  getSpawnSemaphore,
  resetSpawnSemaphoreForTests,
} from '../src/spawn/semaphore.js';
import type { ActionBlock } from '../src/types.js';

function sampleBlock(id: string): ActionBlock {
  return {
    action_id: id,
    task_id: 'task_001',
    session_id: 'session_q',
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

describe('ActionIndexQueue', () => {
  it('processes enqueued blocks serially', async () => {
    const order: string[] = [];
    const queue = new ActionIndexQueue({
      pausePollMs: 5,
      upsert: async (block) => {
        order.push(block.action_id);
        await sleep(10);
      },
    });

    queue.enqueue(sampleBlock('a1'));
    queue.enqueue(sampleBlock('a2'));

    const info = await queue.flush();

    assert.deepEqual(order, ['a1', 'a2']);
    assert.equal(info.count, 2);
    assert.ok(info.flush_ms >= 0);
    resetActionIndexQueueForTests();
  });

  it('pauses indexing while spawn is active', async () => {
    resetSpawnSemaphoreForTests();
    resetActionIndexQueueForTests();
    configureSpawnSemaphore(1);

    const order: string[] = [];
    configureActionIndexQueue({
      pausePollMs: 5,
      upsert: async (block) => {
        order.push(block.action_id);
      },
    });

    const release = await getSpawnSemaphore().acquire();
    enqueueActionIndex(sampleBlock('paused_1'));

    await sleep(30);
    assert.deepEqual(order, []);

    release();
    await flushActionIndex();

    assert.deepEqual(order, ['paused_1']);
    resetActionIndexQueueForTests();
    resetSpawnSemaphoreForTests();
  });

  it('flush drains pending blocks even when spawn is active', async () => {
    resetSpawnSemaphoreForTests();
    configureSpawnSemaphore(1);

    const order: string[] = [];
    const queue = new ActionIndexQueue({
      pausePollMs: 5,
      upsert: async (block) => {
        order.push(block.action_id);
      },
    });

    const release = await getSpawnSemaphore().acquire();
    queue.enqueue(sampleBlock('forced_1'));

    await queue.flush();
    release();

    assert.deepEqual(order, ['forced_1']);
    resetActionIndexQueueForTests();
    resetSpawnSemaphoreForTests();
  });
});