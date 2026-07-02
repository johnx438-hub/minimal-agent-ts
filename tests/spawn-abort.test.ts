import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { SpawnSemaphore, resetSpawnSemaphoreForTests } from '../src/spawn/semaphore.js';

describe('SpawnSemaphore abort', () => {
  it('rejects acquire when signal is already aborted', async () => {
    const sem = new SpawnSemaphore(1);
    const controller = new AbortController();
    controller.abort();

    await assert.rejects(
      () => sem.acquire(controller.signal),
      (err: unknown) => err instanceof DOMException && err.name === 'AbortError',
    );
  });

  it('rejects waiting acquire when signal aborts', async () => {
    const sem = new SpawnSemaphore(1);
    const controller = new AbortController();
    const release = await sem.acquire();

    const waitPromise = sem.acquire(controller.signal);
    controller.abort();

    await assert.rejects(
      waitPromise,
      (err: unknown) => err instanceof DOMException && err.name === 'AbortError',
    );

    release();
    resetSpawnSemaphoreForTests();
  });
});