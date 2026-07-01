import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  checkContentLengthHeader,
  DEFAULT_MAX_RESPONSE_BYTES,
  readBodyWithByteLimit,
  WebFetchResponseTooLargeError,
} from '../src/tools/web-fetch.js';

describe('checkContentLengthHeader', () => {
  it('rejects responses over the byte limit', () => {
    const err = checkContentLengthHeader('6000000', 5_000_000);
    assert.ok(err instanceof WebFetchResponseTooLargeError);
    assert.equal(err.limitBytes, 5_000_000);
    assert.equal(err.actualBytes, 6_000_000);
  });

  it('allows missing or acceptable Content-Length', () => {
    assert.equal(checkContentLengthHeader(null, DEFAULT_MAX_RESPONSE_BYTES), null);
    assert.equal(checkContentLengthHeader('1024', DEFAULT_MAX_RESPONSE_BYTES), null);
  });
});

describe('readBodyWithByteLimit', () => {
  it('reads bodies within the limit', async () => {
    const payload = 'hello world';
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(payload));
        controller.close();
      },
    });

    const body = await readBodyWithByteLimit(stream, 1024);
    assert.equal(body, payload);
  });

  it('aborts when streamed body exceeds the limit', async () => {
    const chunk = new TextEncoder().encode('x'.repeat(200));
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(chunk);
        controller.enqueue(chunk);
        controller.enqueue(chunk);
        controller.close();
      },
    });

    await assert.rejects(
      () => readBodyWithByteLimit(stream, 500),
      WebFetchResponseTooLargeError,
    );
  });
});