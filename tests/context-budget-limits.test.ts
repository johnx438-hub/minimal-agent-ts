import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import {
  createBudgetConfig,
  DEFAULT_CONTEXT_TOKENS,
  getMaxContextTokens,
} from '../src/context-budget.js';

describe('getMaxContextTokens', () => {
  const saved = process.env.MAX_CONTEXT_TOKENS;

  afterEach(() => {
    if (saved === undefined) {
      delete process.env.MAX_CONTEXT_TOKENS;
    } else {
      process.env.MAX_CONTEXT_TOKENS = saved;
    }
  });

  it('uses MAX_CONTEXT_TOKENS when set', () => {
    process.env.MAX_CONTEXT_TOKENS = '200000';
    assert.equal(getMaxContextTokens('deepseek-v4-pro'), 200_000);
  });

  it('maps deepseek-v4-pro to 1M when env unset', () => {
    delete process.env.MAX_CONTEXT_TOKENS;
    assert.equal(getMaxContextTokens('deepseek-v4-pro'), 1_000_000);
  });

  it('falls back to DEFAULT_CONTEXT_TOKENS for unknown models', () => {
    delete process.env.MAX_CONTEXT_TOKENS;
    assert.equal(getMaxContextTokens('unknown-model-xyz'), DEFAULT_CONTEXT_TOKENS);
  });

  it('scales recent_max_tokens with total in createBudgetConfig', () => {
    delete process.env.MAX_CONTEXT_TOKENS;
    const budget = createBudgetConfig('deepseek-v4-pro');
    assert.equal(budget.total, 1_000_000);
    assert.equal(budget.recent_max_tokens, 400_000);
  });
});