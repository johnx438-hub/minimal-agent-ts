import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  appendTaskTranscript,
  buildTranscriptTaskRecord,
  listTranscriptTaskRecords,
  readTranscriptTask,
  resolveTranscriptPolicy,
  transcriptByteSize,
} from '../src/session-transcript.js';
import {
  configureTranscriptWriteQueue,
  flushTranscriptWrites,
  resetTranscriptWriteQueueForTests,
} from '../src/session-transcript-queue.js';
import type { TaskBlock } from '../src/task-tracker.js';
import { setWorkspaceRoot, transcriptPath } from '../src/workspace.js';

function sampleTaskBlock(): TaskBlock {
  return {
    task_id: 'task_abc_001',
    session_id: 'session_test',
    turn_start: 1,
    turn_end: 3,
    messages: [
      { role: 'user', content: 'fix the bug', turn: 1 },
      {
        role: 'assistant',
        content: 'I will edit the file.\n{"pending_tasks":[],"current_work":"editing"}',
        turn: 2,
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: { name: 'edit_file', arguments: '{"path":"src/a.ts"}' },
          },
        ],
      },
      {
        role: 'tool',
        content: '[action:action_abc_1]\nok: edited',
        action_id: 'action_abc_1',
        turn: 2,
      },
      {
        role: 'assistant',
        content: 'Done — fixed the bug.\n{"pending_tasks":[],"current_work":"done"}',
        turn: 3,
      },
    ],
    tool_calls: [{ name: 'edit_file', args: '{"path":"src/a.ts"}' }],
  };
}

describe('buildTranscriptTaskRecord', () => {
  it('stores clean assistant text without JSON tail', () => {
    const record = buildTranscriptTaskRecord(
      sampleTaskBlock(),
      resolveTranscriptPolicy(),
    );
    const assistants = record.messages.filter((m) => m.role === 'assistant');
    assert.equal(assistants.length, 2);
    assert.equal(assistants[0]!.content, 'I will edit the file.');
    assert.equal(assistants[1]!.content, 'Done — fixed the bug.');
    assert.equal(assistants[0]!.has_tool_calls, true);
  });

  it('stores tool stubs without full result text', () => {
    const record = buildTranscriptTaskRecord(
      sampleTaskBlock(),
      resolveTranscriptPolicy(),
    );
    const tool = record.messages.find((m) => m.role === 'tool');
    assert.ok(tool);
    assert.equal(tool!.action_id, 'action_abc_1');
    assert.ok(!('result_text' in (tool as object)));
  });
});

describe('appendTaskTranscript', () => {
  it('writes one jsonl line per completed task', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ma-transcript-'));
    setWorkspaceRoot(dir);
    resetTranscriptWriteQueueForTests();

    const result = appendTaskTranscript('session_test', sampleTaskBlock());
    assert.equal(result.ok, true);
    assert.ok(existsSync(transcriptPath('session_test')));

    const lines = readFileSync(transcriptPath('session_test'), 'utf8')
      .trim()
      .split('\n');
    assert.equal(lines.length, 1);

    const parsed = JSON.parse(lines[0]!);
    assert.equal(parsed.task_id, 'task_abc_001');
    assert.equal(parsed.kind, 'task');
    resetTranscriptWriteQueueForTests();
  });

  it('skips when disabled', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ma-transcript-off-'));
    setWorkspaceRoot(dir);
    resetTranscriptWriteQueueForTests();

    const result = appendTaskTranscript('session_off', sampleTaskBlock(), {
      enabled: false,
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'disabled');
    assert.equal(transcriptByteSize('session_off'), 0);
    resetTranscriptWriteQueueForTests();
  });

  it('skips when max bytes exceeded', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ma-transcript-cap-'));
    setWorkspaceRoot(dir);
    resetTranscriptWriteQueueForTests();

    appendTaskTranscript('session_cap', sampleTaskBlock(), {
      max_bytes_per_session: 10_000,
    });
    const result = appendTaskTranscript('session_cap', sampleTaskBlock(), {
      max_bytes_per_session: 1,
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'max_bytes');
    assert.equal(listTranscriptTaskRecords('session_cap').length, 1);
    resetTranscriptWriteQueueForTests();
  });

  it('exposes pending records before flush for /history', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ma-transcript-pending-'));
    setWorkspaceRoot(dir);
    resetTranscriptWriteQueueForTests();
    configureTranscriptWriteQueue({ sync: false, drainIntervalMs: 60_000 });

    appendTaskTranscript('session_pending', sampleTaskBlock());
    assert.equal(transcriptByteSize('session_pending'), 0);
    assert.equal(listTranscriptTaskRecords('session_pending').length, 1);

    await flushTranscriptWrites();
    assert.ok(transcriptByteSize('session_pending') > 0);
    resetTranscriptWriteQueueForTests();
  });
});

describe('readTranscriptTask', () => {
  it('loads a task record by id', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ma-transcript-read-'));
    setWorkspaceRoot(dir);
    resetTranscriptWriteQueueForTests();
    appendTaskTranscript('session_read', sampleTaskBlock());

    const record = readTranscriptTask('session_read', 'task_abc_001');
    assert.ok(record);
    assert.equal(record!.messages[0]!.role, 'user');
    resetTranscriptWriteQueueForTests();
  });
});