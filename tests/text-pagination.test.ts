import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  clampLineOffset,
  formatScrollFooter,
  pageOffset,
} from '../src/tui/pi/text-pagination.js';

describe('clampLineOffset', () => {
  it('clamps within total minus visible window', () => {
    assert.equal(clampLineOffset(0, 20, 10), 0);
    assert.equal(clampLineOffset(15, 20, 10), 10);
    assert.equal(clampLineOffset(99, 20, 10), 10);
  });

  it('returns 0 for empty content', () => {
    assert.equal(clampLineOffset(5, 0, 10), 0);
  });
});

describe('pageOffset', () => {
  it('moves by visible line count per page', () => {
    assert.equal(pageOffset(0, 25, 10, 1), 10);
    assert.equal(pageOffset(10, 25, 10, 1), 15);
    assert.equal(pageOffset(15, 25, 10, -1), 5);
  });
});

describe('formatScrollFooter', () => {
  it('shows line range and hints when scrollable', () => {
    const footer = formatScrollFooter(0, 30, 10);
    assert.match(footer, /lines 1–10\/30/);
    assert.match(footer, /←\/→/);
  });

  it('omits page hint for short content', () => {
    const footer = formatScrollFooter(0, 5, 10);
    assert.match(footer, /lines 1–5\/5/);
    assert.doesNotMatch(footer, /←\/→/);
  });
});