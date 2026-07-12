import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { AgentStepEvent } from '../src/events.js';
import {
  BridgeStepForwarder,
  createMessageBridge,
  type SessionMessage,
} from '../src/hooks/index.js';
import {
  composeSpawnOnStep,
  resolveSpawnBridgeContext,
} from '../src/spawn/runner.js';

describe('resolveSpawnBridgeContext (MB-4)', () => {
  it('defaults to spawn + preset name', () => {
    assert.deepEqual(resolveSpawnBridgeContext('dev-worker'), {
      source: 'spawn',
      source_id: 'dev-worker',
    });
  });

  it('uses explicit job context', () => {
    assert.deepEqual(
      resolveSpawnBridgeContext('dev-worker', {
        source: 'job',
        source_id: 'job_abc123',
      }),
      { source: 'job', source_id: 'job_abc123' },
    );
  });
});

describe('composeSpawnOnStep (MB-4)', () => {
  it('returns undefined when nothing to compose', () => {
    assert.equal(composeSpawnOnStep({}), undefined);
  });

  it('forwards to bridge with spawn source then nested and job sinks', () => {
    const bag: SessionMessage[] = [];
    const bridge = createMessageBridge();
    bridge.addSink({
      name: 't',
      onMessage(m) {
        bag.push(m);
      },
    });

    const nested: AgentStepEvent[] = [];
    const job: AgentStepEvent[] = [];
    const forwarder = new BridgeStepForwarder(bridge, () => 'spawn_sess_1', {
      source: 'spawn',
      source_id: 'skeleton-reader',
    });

    const onStep = composeSpawnOnStep({
      bridgeForwarder: forwarder,
      nestedSink: (e) => nested.push(e),
      jobOnStep: (e) => job.push(e),
    });
    assert.ok(onStep);

    onStep!({ type: 'turn_start', turn: 1 });
    onStep!({ type: 'final', turn: 1, text: 'sub done' });

    assert.equal(nested.length, 2);
    assert.equal(job.length, 2);
    const assistant = bag.find((m) => m.role === 'assistant');
    assert.ok(assistant);
    assert.equal(assistant?.source, 'spawn');
    assert.equal(assistant?.source_id, 'skeleton-reader');
    assert.equal(assistant?.session_id, 'spawn_sess_1');
    assert.equal(assistant?.content, 'sub done');
  });

  it('tags job source_id for background workers', () => {
    const bag: SessionMessage[] = [];
    const bridge = createMessageBridge();
    bridge.addSink({
      name: 't',
      onMessage(m) {
        bag.push(m);
      },
    });

    const ctx = resolveSpawnBridgeContext('dev-worker', {
      source: 'job',
      source_id: 'job_xyz',
    });
    const forwarder = new BridgeStepForwarder(bridge, () => 'spawn_job_sess', {
      source: ctx.source,
      source_id: ctx.source_id,
    });
    const onStep = composeSpawnOnStep({ bridgeForwarder: forwarder });
    onStep?.({ type: 'tool_result', turn: 2, call_id: 'c1', name: 'read_file', args: '{}', output: 'ok', preview: 'ok' });

    assert.equal(bag.length, 1);
    assert.equal(bag[0]?.source, 'job');
    assert.equal(bag[0]?.source_id, 'job_xyz');
    assert.equal(bag[0]?.session_id, 'spawn_job_sess');
    assert.equal(bag[0]?.role, 'tool');
  });
});
