import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { awaitWithAbort, resolveAbortSignal } from '../src/agent-abort.js';

describe('resolveAbortSignal', () => {
  it('prefers opts.signal over config.abortSignal', () => {
    const opts = new AbortController().signal;
    const config = new AbortController().signal;
    assert.equal(resolveAbortSignal(opts, config), opts);
  });

  it('falls back to config.abortSignal', () => {
    const config = new AbortController().signal;
    assert.equal(resolveAbortSignal(undefined, config), config);
  });
});

describe('awaitWithAbort', () => {
  it('returns the settled value and does not leak abort listeners', async () => {
    const controller = new AbortController();
    let abortEvents = 0;
    controller.signal.addEventListener('abort', () => {
      abortEvents++;
    });

    const value = await awaitWithAbort(Promise.resolve(42), controller.signal);
    assert.equal(value, 42);

    controller.abort();
    assert.equal(abortEvents, 1);
  });

  it('rejects when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      async () => {
        await awaitWithAbort(Promise.resolve(1), controller.signal);
      },
      (err: unknown) => err instanceof DOMException && err.name === 'AbortError',
    );
  });

  it('rejects when the signal aborts before the promise settles', async () => {
    const controller = new AbortController();
    const pending = new Promise<number>((resolve) => {
      setTimeout(() => resolve(1), 50);
    });

    const result = awaitWithAbort(pending, controller.signal);
    controller.abort();

    await assert.rejects(
      () => result,
      (err: unknown) => err instanceof DOMException && err.name === 'AbortError',
    );
  });
});