import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { readBodyWithByteLimit } from '../src/tools/web-fetch.js';

describe('readBodyWithByteLimit abort', () => {
  it('cancels the stream when abortSignal fires', async () => {
    const controller = new AbortController();
    const stream = new ReadableStream<Uint8Array>({
      async pull(ctrl) {
        await new Promise((r) => setTimeout(r, 20));
        ctrl.enqueue(new TextEncoder().encode('chunk'));
      },
    });

    const readPromise = readBodyWithByteLimit(stream, 1024, controller.signal);
    controller.abort();

    await assert.rejects(readPromise, (err: unknown) => {
      return err instanceof DOMException && err.name === 'AbortError';
    });
  });
});