import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  computeRetryDelayMs,
  isRetriableLlmError,
  LlmHttpError,
  parseRetryAfterMs,
} from '../src/llm-retry.js';

describe('parseRetryAfterMs', () => {
  it('parses delay seconds', () => {
    assert.equal(parseRetryAfterMs('2'), 2000);
  });

  it('parses HTTP date in the future', () => {
    const future = new Date(Date.now() + 5000).toUTCString();
    const ms = parseRetryAfterMs(future);
    assert.ok(ms !== undefined && ms > 0 && ms <= 6000);
  });
});

describe('isRetriableLlmError', () => {
  it('retries 429 before tokens are emitted', () => {
    const err = new LlmHttpError(429, 'rate limited', 3000);
    assert.equal(isRetriableLlmError(err, false), true);
  });

  it('does not retry after partial stream tokens', () => {
    const err = new LlmHttpError(503, 'unavailable');
    assert.equal(isRetriableLlmError(err, true), false);
  });

  it('does not retry 401', () => {
    const err = new LlmHttpError(401, 'unauthorized');
    assert.equal(isRetriableLlmError(err, false), false);
  });

  it('retries network TypeError', () => {
    assert.equal(isRetriableLlmError(new TypeError('fetch failed'), false), true);
  });

  it('does not retry abort', () => {
    assert.equal(
      isRetriableLlmError(new DOMException('Aborted', 'AbortError'), false),
      false,
    );
  });
});

describe('computeRetryDelayMs', () => {
  it('prefers retry-after from 429', () => {
    const err = new LlmHttpError(429, 'slow down', 4500);
    assert.equal(
      computeRetryDelayMs(err, 1, { maxAttempts: 3, baseDelayMs: 1000, maxDelayMs: 30_000 }),
      4500,
    );
  });

  it('uses exponential backoff when no retry-after', () => {
    const err = new LlmHttpError(500, 'boom');
    const first = computeRetryDelayMs(err, 1, {
      maxAttempts: 3,
      baseDelayMs: 1000,
      maxDelayMs: 30_000,
    });
    const second = computeRetryDelayMs(err, 2, {
      maxAttempts: 3,
      baseDelayMs: 1000,
      maxDelayMs: 30_000,
    });
    assert.ok(first >= 1000 && first < 1300);
    assert.ok(second >= 2000 && second < 2300);
  });
});