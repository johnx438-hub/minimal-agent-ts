import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { emitJsonEvent } from '../src/events.js';
import {
  workflowConfirmEndEvent,
  workflowConfirmStartEvent,
} from '../src/workflow-checkpoint.js';
import type { WorkflowCheckpointInfo } from '../src/workflow-checkpoint.js';

const sampleCheckpoint: WorkflowCheckpointInfo = {
  name: 'review-loop',
  path: '/tmp/workflows/review-loop.json',
  needsShell: true,
  needsWeb: false,
  roles: [
    {
      name: 'reviewer',
      tools: ['read_file', 'run_shell'],
      needsShell: true,
      needsWeb: false,
    },
  ],
};

describe('emitJsonEvent lifecycle', () => {
  it('serializes workflow_confirm_start and workflow_confirm_end', () => {
    const start = workflowConfirmStartEvent(sampleCheckpoint);
    assert.equal(start.type, 'workflow_confirm_start');
    assert.equal(start.workflow, 'review-loop');
    assert.equal(start.roles[0]?.needs_shell, true);

    const end = workflowConfirmEndEvent(sampleCheckpoint, true);
    assert.equal(end.type, 'workflow_confirm_end');
    assert.equal(end.reason, 'approved');

    const aborted = workflowConfirmEndEvent(sampleCheckpoint, false, AbortSignal.abort());
    assert.equal(aborted.reason, 'aborted');
    assert.equal(aborted.approved, false);
  });

  it('serializes permission_prompt events', () => {
    const chunks: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array) => {
      chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
      return true;
    }) as typeof process.stdout.write;

    try {
      emitJsonEvent({ type: 'permission_prompt_start', kind: 'shell', reason: 'run_shell' });
      emitJsonEvent({
        type: 'permission_prompt_end',
        kind: 'shell',
        approved: false,
        reason: 'aborted',
      });
      const lines = chunks.join('').trim().split('\n');
      assert.equal(lines.length, 2);
      const start = JSON.parse(lines[0]!).event;
      const end = JSON.parse(lines[1]!).event;
      assert.equal(start.type, 'permission_prompt_start');
      assert.equal(end.reason, 'aborted');
    } finally {
      process.stdout.write = original;
    }
  });

  it('serializes run_stopping for --json-events consumers', () => {
    const chunks: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array) => {
      chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
      return true;
    }) as typeof process.stdout.write;

    try {
      emitJsonEvent({ type: 'run_stopping', session_id: 'sess_test' });
      const line = chunks.join('').trim();
      const parsed = JSON.parse(line) as {
        ts: number;
        event: { type: string; session_id: string };
      };
      assert.equal(parsed.event.type, 'run_stopping');
      assert.equal(parsed.event.session_id, 'sess_test');
      assert.equal(typeof parsed.ts, 'number');
    } finally {
      process.stdout.write = original;
    }
  });
});