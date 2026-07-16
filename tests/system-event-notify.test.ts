import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  createMessageBridge,
  createSystemEventHub,
  formatSystemEventForHumans,
  formatSystemEventSyntheticPrompt,
  isSyntheticSystemEventPrompt,
  type SessionMessage,
  type SystemEvent,
} from '../src/hooks/index.js';
import { SessionInboundQueue } from '../src/hooks/session-inbound-queue.js';

function baseJob(partial: Partial<SystemEvent> & Pick<SystemEvent, 'kind' | 'event_id'>): SystemEvent {
  return {
    timestamp: 1,
    session_id: 'sess_1',
    job_id: 'job_a',
    preset: 'dev-worker',
    status: 'completed',
    ok: true,
    summary_line: 'done work',
    still_running: 1,
    still_running_ids: ['job_b'],
    ...partial,
  };
}

describe('formatSystemEventForHumans', () => {
  it('marks not a user message and includes still_running', () => {
    const text = formatSystemEventForHumans(
      baseJob({ kind: 'job_complete', event_id: 'e1' }),
    );
    assert.match(text, /not a user message/i);
    assert.match(text, /job_complete/);
    assert.match(text, /still_running: 1/);
    assert.match(text, /job_b/);
  });

  it('formats workflow digest', () => {
    const text = formatSystemEventForHumans({
      kind: 'workflow_complete',
      timestamp: 1,
      session_id: 's',
      event_id: 'w1',
      workflow: 'dag-review',
      digest: '✓ Workflow complete',
    });
    assert.match(text, /workflow_complete/);
    assert.match(text, /dag-review/);
    assert.match(text, /digest/);
  });
});

describe('system event hub', () => {
  it('emits bridge system_notice and dedupes event_id per hub', () => {
    const bag: SessionMessage[] = [];
    const bridge = createMessageBridge();
    bridge.addSink({
      name: 't',
      onMessage(m) {
        bag.push(m);
      },
    });
    const hub = createSystemEventHub({ bridge });
    const ev = baseJob({ kind: 'job_complete', event_id: 'dup1' });
    assert.equal(hub.notify(ev), true);
    assert.equal(hub.notify(ev), false);
    assert.equal(bag.length, 1);
    assert.equal(bag[0]?.role, 'system_notice');
    assert.equal(bag[0]?.source, 'job');
    assert.equal(bag[0]?.source_id, 'job_a');
    assert.match(String(bag[0]?.content), /not a user message/i);

    // Separate hub does not share dedupe set
    const hub2 = createSystemEventHub({ config: { bridge: false } });
    assert.equal(
      hub2.notify(baseJob({ kind: 'job_complete', event_id: 'dup1' })),
      true,
    );
  });

  it('enqueues auto_run only for configured kinds when auto_run true', () => {
    const inbound = new SessionInboundQueue();
    let maybe = 0;
    const hub = createSystemEventHub({
      config: {
        bridge: false,
        auto_run: true,
        auto_run_kinds: ['jobs_all_settled', 'workflow_complete'],
        merge: 'per_event',
      },
      inboundQueue: inbound,
      onMaybeAutoRun: () => {
        maybe += 1;
      },
    });

    hub.notify(
      baseJob({ kind: 'job_complete', event_id: 'j1', still_running: 0 }),
    );
    assert.equal(inbound.pendingCount('sess_1'), 0);

    hub.notify({
      kind: 'jobs_all_settled',
      timestamp: 2,
      session_id: 'sess_1',
      event_id: 'all1',
      still_running: 0,
    });
    assert.equal(inbound.pendingCount('sess_1'), 1);
    assert.equal(maybe, 1);

    const drained = inbound.drain('sess_1');
    assert.equal(drained.length, 1);
    assert.equal(drained[0]?.event.kind, 'jobs_all_settled');
  });

  it('synthetic prompt is wrapped as system_event and detected', () => {
    const p = formatSystemEventSyntheticPrompt([
      baseJob({ kind: 'job_complete', event_id: 'x' }),
    ]);
    assert.match(p, /<system_event not_user_message="true">/);
    assert.match(p, /NOT a human user message/i);
    assert.equal(isSyntheticSystemEventPrompt(p), true);
    assert.equal(
      isSyntheticSystemEventPrompt('please use <system_event in docs'),
      false,
    );
  });
});

describe('SessionInboundQueue', () => {
  it('drains FIFO auto_run items', () => {
    const q = new SessionInboundQueue();
    q.enqueue('s', {
      event: baseJob({ kind: 'job_complete', event_id: 'a' }),
      enqueued_at: 1,
      auto_run: true,
    });
    q.enqueue('s', {
      event: baseJob({ kind: 'job_complete', event_id: 'b', job_id: 'job_b' }),
      enqueued_at: 2,
      auto_run: false,
    });
    const d = q.drain('s', { onlyAutoRun: true });
    assert.equal(d.length, 1);
    assert.equal(d[0]?.event.event_id, 'a');
    assert.equal(q.pendingCount('s'), 1);
  });
});
