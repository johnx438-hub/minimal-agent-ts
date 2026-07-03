import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  beginTurnIo,
  buildTurnIoEvent,
  recordActionSave,
  resetActionIoMetricsForTests,
} from '../src/action-io-metrics.js';
import { saveAction } from '../src/action-store.js';
import {
  configureActionWriteQueue,
  resetActionWriteQueueForTests,
} from '../src/action-write-queue.js';
import type { ActionBlock } from '../src/types.js';
import { setWorkspaceRoot } from '../src/workspace.js';

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

describe('action io metrics', () => {
  it('async mode attributes turn_io ms to flush batches, not enqueue', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ma-io-metrics-'));
    setWorkspaceRoot(dir);
    resetActionWriteQueueForTests();
    resetActionIoMetricsForTests();

    configureActionWriteQueue({
      sync: false,
      drainIntervalMs: 5,
      maxBatch: 4,
    });

    beginTurnIo(1);
    saveAction(sampleBlock('metrics_async_1'));
    saveAction(sampleBlock('metrics_async_2'));

    await sleep(40);

    const event = buildTurnIoEvent(1);
    assert.ok(event);
    assert.equal(event.type, 'turn_io');
    assert.equal(event.actions_saved, 2);
    assert.ok(event.action_save_ms > 0, 'async turn_io should use batch flush ms');

    resetActionWriteQueueForTests();
  });

  it('sync mode keeps per-call save latency', () => {
    resetActionIoMetricsForTests();
    beginTurnIo(2);
    recordActionSave(1.25);
    recordActionSave(-1);

    const event = buildTurnIoEvent(2);
    assert.ok(event);
    assert.equal(event.actions_saved, 2);
    assert.equal(event.action_save_ms, 1.25);
  });
});