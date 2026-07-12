import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildUserTaskMessage,
  createMessageBridge,
  createThrottledAssistantEmitter,
  DEFAULT_TOKEN_THROTTLE_MS,
  type SessionMessage,
} from '../src/hooks/index.js';

function collectSink(name: string, bag: SessionMessage[]) {
  return {
    name,
    onMessage(msg: SessionMessage) {
      bag.push(msg);
    },
  };
}

describe('buildUserTaskMessage', () => {
  it('builds a main-session user message at turn 0', () => {
    const msg = buildUserTaskMessage('sess_1', 'do the thing', { timestamp: 42 });
    assert.deepEqual(msg, {
      session_id: 'sess_1',
      turn: 0,
      role: 'user',
      content: 'do the thing',
      timestamp: 42,
      task_id: undefined,
      source: 'main',
      source_id: undefined,
    });
  });
});

describe('createMessageBridge', () => {
  it('emit is a no-op with zero sinks', () => {
    const bridge = createMessageBridge();
    assert.equal(bridge.sinkCount(), 0);
    bridge.emit({
      session_id: 's1',
      turn: 1,
      role: 'user',
      content: 'hi',
      timestamp: 1,
    });
  });

  it('fans out to all sinks and supports unsubscribe', () => {
    const a: SessionMessage[] = [];
    const b: SessionMessage[] = [];
    const bridge = createMessageBridge();
    const unsubA = bridge.addSink(collectSink('a', a));
    bridge.addSink(collectSink('b', b));
    assert.equal(bridge.sinkCount(), 2);

    const msg: SessionMessage = {
      session_id: 's1',
      turn: 2,
      role: 'user',
      content: 'task',
      timestamp: 10,
      source: 'main',
    };
    bridge.emit(msg);
    assert.equal(a.length, 1);
    assert.equal(b.length, 1);
    assert.equal(a[0]?.content, 'task');

    unsubA();
    assert.equal(bridge.sinkCount(), 1);
    bridge.emit({ ...msg, content: 'again', timestamp: 11 });
    assert.equal(a.length, 1);
    assert.equal(b.length, 2);
    assert.equal(b[1]?.content, 'again');
  });

  it('replaces sink with the same name', () => {
    const first: SessionMessage[] = [];
    const second: SessionMessage[] = [];
    const bridge = createMessageBridge();
    bridge.addSink(collectSink('log', first));
    bridge.addSink(collectSink('log', second));
    assert.equal(bridge.sinkCount(), 1);
    bridge.emit({
      session_id: 's',
      turn: 1,
      role: 'user',
      content: 'x',
      timestamp: 1,
    });
    assert.equal(first.length, 0);
    assert.equal(second.length, 1);
  });

  it('rejects empty sink names', () => {
    const bridge = createMessageBridge();
    assert.throws(() => bridge.addSink({ name: '  ', onMessage() {} }), /non-empty/);
  });

  it('isolates synchronous sink throws', () => {
    const ok: SessionMessage[] = [];
    const errors: Array<{ name: string; err: unknown }> = [];
    const bridge = createMessageBridge({
      onSinkError: (name, err) => errors.push({ name, err }),
    });
    bridge.addSink({
      name: 'boom',
      onMessage() {
        throw new Error('sync fail');
      },
    });
    bridge.addSink(collectSink('ok', ok));

    bridge.emit({
      session_id: 's',
      turn: 1,
      role: 'assistant',
      content: 'hello',
      timestamp: 1,
    });

    assert.equal(ok.length, 1);
    assert.equal(errors.length, 1);
    assert.equal(errors[0]?.name, 'boom');
    assert.match(String(errors[0]?.err), /sync fail/);
  });

  it('isolates async sink rejections', async () => {
    const ok: SessionMessage[] = [];
    const errors: Array<{ name: string; err: unknown }> = [];
    const bridge = createMessageBridge({
      onSinkError: (name, err) => errors.push({ name, err }),
    });
    bridge.addSink({
      name: 'async-boom',
      async onMessage() {
        throw new Error('async fail');
      },
    });
    bridge.addSink(collectSink('ok', ok));

    bridge.emit({
      session_id: 's',
      turn: 1,
      role: 'tool',
      content: 'preview',
      timestamp: 1,
      tool_name: 'read_file',
    });

    assert.equal(ok.length, 1);
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(errors.length, 1);
    assert.equal(errors[0]?.name, 'async-boom');
    assert.match(String(errors[0]?.err), /async fail/);
  });

  it('swallows errors thrown by onSinkError itself', () => {
    const ok: SessionMessage[] = [];
    const bridge = createMessageBridge({
      onSinkError() {
        throw new Error('handler boom');
      },
    });
    bridge.addSink({
      name: 'boom',
      onMessage() {
        throw new Error('sink fail');
      },
    });
    bridge.addSink(collectSink('ok', ok));

    assert.doesNotThrow(() =>
      bridge.emit({
        session_id: 's',
        turn: 1,
        role: 'user',
        content: 'x',
        timestamp: 1,
      }),
    );
    assert.equal(ok.length, 1);
  });
});

describe('createThrottledAssistantEmitter', () => {
  it('defaults interval to DEFAULT_TOKEN_THROTTLE_MS (throttling on)', () => {
    assert.equal(DEFAULT_TOKEN_THROTTLE_MS, 80);
  });

  it('coalesces deltas within the interval then emits final content', () => {
    const bag: SessionMessage[] = [];
    const bridge = createMessageBridge();
    bridge.addSink(collectSink('t', bag));

    let t = 1000;
    const pending: Array<() => void> = [];
    const emitter = createThrottledAssistantEmitter(
      bridge,
      { session_id: 's1', turn: 3, source: 'main' },
      {
        intervalMs: 50,
        now: () => t,
        setTimer: (fn, _ms) => {
          pending.push(fn);
          return 1 as unknown as ReturnType<typeof setTimeout>;
        },
        clearTimer: () => {
          pending.length = 0;
        },
      },
    );

    emitter.pushDelta('Hel');
    assert.equal(bag.length, 1);
    assert.equal(bag[0]?.delta, 'Hel');
    assert.equal(bag[0]?.role, 'assistant');

    t += 10;
    emitter.pushDelta('lo');
    // Still inside throttle window — buffered, not emitted yet.
    assert.equal(bag.length, 1);
    assert.equal(pending.length, 1);

    t += 50;
    pending.shift()?.();
    assert.equal(bag.length, 2);
    assert.equal(bag[1]?.delta, 'lo');

    emitter.flushFinal('Hello world');
    assert.equal(bag.length, 3);
    assert.equal(bag[2]?.content, 'Hello world');
    assert.equal(bag[2]?.delta, undefined);
  });

  it('intervalMs 0 emits every delta immediately', () => {
    const bag: SessionMessage[] = [];
    const bridge = createMessageBridge();
    bridge.addSink(collectSink('t', bag));
    const emitter = createThrottledAssistantEmitter(
      bridge,
      { session_id: 's', turn: 1 },
      { intervalMs: 0 },
    );
    emitter.pushDelta('a');
    emitter.pushDelta('b');
    assert.equal(bag.length, 2);
    assert.equal(bag[0]?.delta, 'a');
    assert.equal(bag[1]?.delta, 'b');
  });

  it('dispose drops buffer without further emits', () => {
    const bag: SessionMessage[] = [];
    const bridge = createMessageBridge();
    bridge.addSink(collectSink('t', bag));
    let t = 0;
    const pending: Array<() => void> = [];
    const emitter = createThrottledAssistantEmitter(
      bridge,
      { session_id: 's', turn: 1 },
      {
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
    );
    emitter.pushDelta('first');
    assert.equal(bag.length, 1);
    t += 10;
    emitter.pushDelta('buffered');
    emitter.dispose();
    pending.shift()?.();
    emitter.pushDelta('ignored');
    emitter.flushFinal('nope');
    assert.equal(bag.length, 1);
  });

  it('flushes early when minChars is reached', () => {
    const bag: SessionMessage[] = [];
    const bridge = createMessageBridge();
    bridge.addSink(collectSink('t', bag));
    let t = 0;
    const pending: Array<() => void> = [];
    const emitter = createThrottledAssistantEmitter(
      bridge,
      { session_id: 's', turn: 1 },
      {
        intervalMs: 10_000,
        minChars: 5,
        now: () => t,
        setTimer: (fn) => {
          pending.push(fn);
          return 1 as unknown as ReturnType<typeof setTimeout>;
        },
        clearTimer: () => {
          pending.length = 0;
        },
      },
    );

    emitter.pushDelta('ab');
    assert.equal(bag.length, 1, 'first delta flushes when lastEmitAt is null');
    assert.equal(bag[0]?.delta, 'ab');
    t += 1;
    emitter.pushDelta('12');
    assert.equal(bag.length, 1, 'under minChars stays buffered inside throttle window');
    assert.equal(pending.length, 1);
    emitter.pushDelta('345');
    assert.equal(bag.length, 2, 'minChars forces flush before interval');
    assert.equal(bag[1]?.delta, '12345');
  });
});
