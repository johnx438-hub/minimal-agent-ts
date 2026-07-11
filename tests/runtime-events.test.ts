import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildJsonEventEnvelope,
  emitJsonEvent,
  normalizeRuntimeEventForJson,
  parseJsonEventLine,
  serializeRuntimeEvent,
} from '../src/events.js';
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

  it('serializes tool_result display for --json-events consumers', () => {
    const event = normalizeRuntimeEventForJson({
      type: 'tool_result',
      turn: 2,
      call_id: 'call_write_1',
      name: 'write_file',
      args: '{"path":"src/a.ts","content":"hello"}',
      output: 'ok: wrote 5 bytes to src/a.ts (new file)',
      preview: 'ok: wrote 5 bytes to src/a.ts (new file)',
      display: '--- /dev/null\n+++ b/src/a.ts\n@@ src/a.ts @@\n+ hello',
    });

    assert.equal(event.type, 'tool_result');
    if (event.type !== 'tool_result') return;
    assert.equal(event.call_id, 'call_write_1');
    assert.match(event.display ?? '', /\+ hello/);

    const line = serializeRuntimeEvent(event, 1_700_000_000_000);
    const parsed = parseJsonEventLine(line);
    assert.equal(parsed.ts, 1_700_000_000_000);
    assert.equal(parsed.event.type, 'tool_result');
    if (parsed.event.type !== 'tool_result') return;
    assert.equal(parsed.event.name, 'write_file');
    assert.equal(parsed.event.output, 'ok: wrote 5 bytes to src/a.ts (new file)');
    assert.match(parsed.event.display ?? '', /--- \/dev\/null/);
    assert.match(parsed.event.display ?? '', /\n\+ hello/);
    assert.match(line, /\\n/); // display newlines are JSON-escaped on the wire
  });

  it('omits empty tool_result display from json events', () => {
    const event = normalizeRuntimeEventForJson({
      type: 'tool_result',
      turn: 1,
      call_id: 'call_read_1',
      name: 'read_file',
      args: '{"path":"README.md"}',
      output: '# Title',
      display: '',
    });
    if (event.type !== 'tool_result') return;
    assert.equal(event.display, undefined);

    const parsed = parseJsonEventLine(serializeRuntimeEvent(event));
    if (parsed.event.type !== 'tool_result') return;
    assert.equal('display' in parsed.event, false);
  });

  it('buildJsonEventEnvelope preserves tool_call call_id', () => {
    const envelope = buildJsonEventEnvelope({
      type: 'tool_call',
      turn: 3,
      call_id: 'call_edit_9',
      name: 'edit_file',
      args: '{"path":"x.ts","old_string":"a","new_string":"b"}',
    });
    assert.equal(envelope.event.type, 'tool_call');
    if (envelope.event.type !== 'tool_call') return;
    assert.equal(envelope.event.call_id, 'call_edit_9');
  });

  it('serializes turn_io and action_flush metrics', () => {
    const turnIo = serializeRuntimeEvent({
      type: 'turn_io',
      turn: 2,
      actions_saved: 3,
      action_save_ms: 0.12,
      queue_depth: 1,
    });
    const parsedTurn = parseJsonEventLine(turnIo);
    assert.equal(parsedTurn.event.type, 'turn_io');
    assert.equal(
      (parsedTurn.event as { actions_saved: number }).actions_saved,
      3,
    );

    const flush = serializeRuntimeEvent({
      type: 'action_flush',
      flush_ms: 4.5,
      count: 2,
      pending: 0,
    });
    const parsedFlush = parseJsonEventLine(flush);
    assert.equal(parsedFlush.event.type, 'action_flush');
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