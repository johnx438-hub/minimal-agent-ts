import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  BridgeStepForwarder,
  DEFAULT_TOOL_BRIDGE_SUMMARY_CHARS,
  summarizeToolResultForBridge,
} from '../src/hooks/bridge-step-forwarder.js';
import {
  createMessageBridge,
  type SessionMessage,
} from '../src/hooks/message-bridge.js';

function collect(bag: SessionMessage[]) {
  return {
    name: 't',
    onMessage(msg: SessionMessage) {
      bag.push(msg);
    },
  };
}

describe('BridgeStepForwarder (MB-2)', () => {
  it('coalesces token deltas then emits final content', () => {
    const bag: SessionMessage[] = [];
    const bridge = createMessageBridge();
    bridge.addSink(collect(bag));

    let t = 1000;
    const pending: Array<() => void> = [];
    const forwarder = new BridgeStepForwarder(bridge, () => 'sess_1', {
      source: 'main',
      throttle: {
        intervalMs: 50,
        now: () => t,
        setTimer: (fn) => {
          pending.push(fn);
          return 1 as unknown as ReturnType<typeof setTimeout>;
        },
        clearTimer: () => {
          pending.length = 0;
        },
      },
    });

    forwarder.onStep({ type: 'turn_start', turn: 1 });
    forwarder.onStep({ type: 'token', turn: 1, delta: 'Hel' });
    assert.equal(bag.length, 1);
    assert.equal(bag[0]?.delta, 'Hel');
    assert.equal(bag[0]?.role, 'assistant');
    assert.equal(bag[0]?.turn, 1);

    t += 10;
    forwarder.onStep({ type: 'token', turn: 1, delta: 'lo' });
    assert.equal(bag.length, 1);

    t += 50;
    pending.shift()?.();
    assert.equal(bag.length, 2);
    assert.equal(bag[1]?.delta, 'lo');

    forwarder.onStep({ type: 'final', turn: 1, text: 'Hello' });
    assert.equal(bag[bag.length - 1]?.content, 'Hello');
    assert.equal(bag[bag.length - 1]?.delta, undefined);
  });

  it('emits final only when no tokens (non-streaming)', () => {
    const bag: SessionMessage[] = [];
    const bridge = createMessageBridge();
    bridge.addSink(collect(bag));
    const forwarder = new BridgeStepForwarder(bridge, () => 'sess_2');

    forwarder.onStep({ type: 'turn_start', turn: 2 });
    forwarder.onStep({ type: 'final', turn: 2, text: 'done' });

    assert.equal(bag.length, 1);
    assert.equal(bag[0]?.role, 'assistant');
    assert.equal(bag[0]?.content, 'done');
    assert.equal(bag[0]?.turn, 2);
  });

  it('ignores steps without session id', () => {
    const bag: SessionMessage[] = [];
    const bridge = createMessageBridge();
    bridge.addSink(collect(bag));
    const forwarder = new BridgeStepForwarder(bridge, () => undefined);

    forwarder.onStep({ type: 'turn_start', turn: 1 });
    forwarder.onStep({ type: 'token', turn: 1, delta: 'x' });
    forwarder.onStep({ type: 'final', turn: 1, text: 'y' });
    assert.equal(bag.length, 0);
  });

  it('dispose drops buffered tokens', () => {
    const bag: SessionMessage[] = [];
    const bridge = createMessageBridge();
    bridge.addSink(collect(bag));
    let t = 0;
    const pending: Array<() => void> = [];
    const forwarder = new BridgeStepForwarder(bridge, () => 's', {
      throttle: {
        intervalMs: 100,
        now: () => t,
        setTimer: (fn) => {
          pending.push(fn);
          return 1 as unknown as ReturnType<typeof setTimeout>;
        },
        clearTimer: () => {
          pending.length = 0;
        },
      },
    });

    forwarder.onStep({ type: 'turn_start', turn: 1 });
    forwarder.onStep({ type: 'token', turn: 1, delta: 'a' });
    assert.equal(bag.length, 1);
    t += 10;
    forwarder.onStep({ type: 'token', turn: 1, delta: 'b' });
    forwarder.dispose();
    pending.shift()?.();
    assert.equal(bag.length, 1);
  });

  it('skips tool_call and llm_done (not tool_result)', () => {
    const bag: SessionMessage[] = [];
    const bridge = createMessageBridge();
    bridge.addSink(collect(bag));
    const forwarder = new BridgeStepForwarder(bridge, () => 's');
    forwarder.onStep({ type: 'tool_call', turn: 1, call_id: 'c', name: 'read_file', args: '{}' });
    forwarder.onStep({ type: 'llm_done', turn: 1, finishReason: 'stop' });
    assert.equal(bag.length, 0);
  });

  it('emits tool_result using preview, not full output (MB-3)', () => {
    const bag: SessionMessage[] = [];
    const bridge = createMessageBridge();
    bridge.addSink(collect(bag));
    const forwarder = new BridgeStepForwarder(bridge, () => 'sess_tool');

    const huge = 'x'.repeat(50_000);
    forwarder.onStep({
      type: 'tool_result',
      turn: 3,
      call_id: 'tc1',
      name: 'read_file',
      args: '{}',
      output: huge,
      preview: 'export function foo() { …',
    });

    assert.equal(bag.length, 1);
    assert.equal(bag[0]?.role, 'tool');
    assert.equal(bag[0]?.tool_name, 'read_file');
    assert.equal(bag[0]?.call_id, 'tc1');
    assert.equal(bag[0]?.content, 'export function foo() { …');
    assert.ok((bag[0]?.content?.length ?? 0) < 1000);
    assert.ok(!bag[0]?.content?.includes(huge.slice(0, 100)));
  });

  it('truncates output when preview is missing', () => {
    const bag: SessionMessage[] = [];
    const bridge = createMessageBridge();
    bridge.addSink(collect(bag));
    const forwarder = new BridgeStepForwarder(bridge, () => 's', {
      toolSummaryMaxChars: 40,
    });

    forwarder.onStep({
      type: 'tool_result',
      turn: 1,
      call_id: 'tc2',
      name: 'run_shell',
      args: '{}',
      output: 'a'.repeat(200),
    });

    assert.equal(bag.length, 1);
    assert.ok((bag[0]?.content?.length ?? 0) <= 41);
    assert.match(bag[0]?.content ?? '', /…$/);
  });
});

describe('summarizeToolResultForBridge', () => {
  it('prefers preview over output', () => {
    assert.equal(
      summarizeToolResultForBridge({
        name: 'read_file',
        output: 'FULL BODY',
        preview: 'short',
      }),
      'short',
    );
  });

  it('keeps compact pointer cards under expanded limit', () => {
    const card =
      '[action:action_abc]\ntool=read_file path=a.ts chars=10\nsummary=hi\nrecall=recall_query(action_id="action_abc")';
    const out = summarizeToolResultForBridge({ name: 'read_file', output: card });
    assert.equal(out, card);
  });

  it('labels empty tool output', () => {
    assert.equal(
      summarizeToolResultForBridge({ name: 'list_files', output: '  ' }),
      '(list_files: empty)',
    );
  });

  it('exports default max chars', () => {
    assert.equal(DEFAULT_TOOL_BRIDGE_SUMMARY_CHARS, 400);
  });
});

