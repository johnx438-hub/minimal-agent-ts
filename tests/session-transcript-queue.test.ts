import assert from 'node:assert/strict';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  TranscriptWriteQueue,
  configureTranscriptWriteQueue,
  flushTranscriptWrites,
  getTranscriptWriteQueue,
  resetTranscriptWriteQueueForTests,
} from '../src/session-transcript-queue.js';
import type { TranscriptTaskRecord } from '../src/session-transcript.js';
import { setWorkspaceRoot, transcriptPath } from '../src/workspace.js';

function sampleRecord(taskId: string): TranscriptTaskRecord {
  return {
    v: 1,
    kind: 'task',
    session_id: 'session_q',
    task_id: taskId,
    completed_at: Date.now(),
    turn_range: [1, 2],
    messages: [{ role: 'user', turn: 1, content: 'hello' }],
  };
}

describe('TranscriptWriteQueue', () => {
  it('flushes enqueued records asynchronously', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ma-transcript-q-'));
    setWorkspaceRoot(dir);
    resetTranscriptWriteQueueForTests();
    configureTranscriptWriteQueue({ sync: false, drainIntervalMs: 5 });

    getTranscriptWriteQueue().enqueue('session_q', sampleRecord('task_async_1'));

    assert.equal(existsSync(transcriptPath('session_q')), false);
    await flushTranscriptWrites();
    assert.ok(existsSync(transcriptPath('session_q')));
    resetTranscriptWriteQueueForTests();
  });

  it('flushSync drains pending records', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ma-transcript-sync-'));
    setWorkspaceRoot(dir);

    const queue = new TranscriptWriteQueue({ sync: false, drainIntervalMs: 60_000 });
    queue.enqueue('session_sync', sampleRecord('task_sync_1'));

    const info = queue.flushSync();
    assert.equal(info.count, 1);
    assert.equal(info.pending, 0);
    assert.ok(existsSync(transcriptPath('session_sync')));
    queue.dispose();
    resetTranscriptWriteQueueForTests();
  });
});