import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  CHARS_PER_TOKEN,
  estimateTextTokens,
  estimateTokens,
} from '../src/context/budget.js';
import type { ChatMessage } from '../src/types.js';

function fillerTokens(targetTokens: number): string {
  return 'x'.repeat(Math.ceil(targetTokens * CHARS_PER_TOKEN) + 50);
}

describe('estimateTextTokens', () => {
  it('counts CJK by character length, not whitespace', () => {
    const chinese = '这是一段没有空格的中文测试内容用于验证字符估算不会因为整段被当成一个词而严重低估';
    assert.ok(chinese.split(/\s+/).length === 1);
    assert.ok(estimateTextTokens(chinese) > 10);
  });

  it('counts English prose similarly to char-based budget', () => {
    const english = 'The quick brown fox jumps over the lazy dog';
    const expected = Math.ceil(english.length / CHARS_PER_TOKEN);
    assert.equal(estimateTextTokens(english), expected);
  });

  it('handles mixed CJK and Latin', () => {
    const mixed = '实现 feature X 需要 read_file 和 write_file';
    assert.ok(estimateTextTokens(mixed) >= Math.ceil(mixed.length / CHARS_PER_TOKEN));
  });
});

describe('estimateTokens filler helper', () => {
  it('reaches target token budget for compression thresholds', () => {
    const target = 50_000;
    const messages: ChatMessage[] = [{ role: 'user', content: fillerTokens(target) }];
    assert.ok(estimateTokens(messages) >= target);
  });
});