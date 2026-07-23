import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  createBudgetConfig,
  heavyCompressionThreshold,
  shouldRunHeavyCompression,
  usableContextTokens,
} from '../src/context/budget.js';
import { normalizeContextPolicy } from '../src/context/policy-config.js';
import { runTurnEndPipeline } from '../src/context/pipeline.js';
import { CHARS_PER_TOKEN } from '../src/context/budget.js';
import type { ChatMessage } from '../src/types.js';

function fillerTokens(targetTokens: number): string {
  return 'x'.repeat(Math.ceil(targetTokens * CHARS_PER_TOKEN) + 50);
}

describe('createBudgetConfig + context_policy (C2)', () => {
  it('omit policy matches default heavy thresholds', () => {
    const a = createBudgetConfig('unknown');
    const b = createBudgetConfig('unknown', normalizeContextPolicy(undefined));
    assert.equal(a.first_heavy_ratio, b.first_heavy_ratio);
    assert.equal(a.repeat_heavy_ratio, b.repeat_heavy_ratio);
    assert.equal(
      heavyCompressionThreshold(a, false),
      heavyCompressionThreshold(b, false),
    );
  });

  it('lower first_ratio lowers heavy threshold', () => {
    const base = createBudgetConfig('unknown');
    const aggressive = createBudgetConfig(
      'unknown',
      normalizeContextPolicy({
        heavy_compression: { first_ratio: 0.55, repeat_ratio: 0.7 },
      }),
    );
    assert.ok(
      heavyCompressionThreshold(aggressive, false) <
        heavyCompressionThreshold(base, false),
    );
    assert.equal(aggressive.first_heavy_ratio, 0.55);
    assert.equal(aggressive.repeat_heavy_ratio, 0.7);
  });

  it('budget layer pct from policy affects usable context', () => {
    const highSystem = createBudgetConfig(
      'unknown',
      normalizeContextPolicy({
        budget: { system_pct: 0.2 },
      }),
    );
    const base = createBudgetConfig('unknown');
    assert.ok(usableContextTokens(highSystem) < usableContextTokens(base));
  });
});

describe('pipeline respects contextPolicy prune/protect knobs', () => {
  it('still no-ops on turn 1 with custom policy', () => {
    const policy = normalizeContextPolicy({
      heavy_compression: { first_ratio: 0.5 },
      prune: { min_savings_tokens: 1 },
    });
    const budget = createBudgetConfig('unknown', policy);
    const messages: ChatMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: fillerTokens(50_000) },
    ];
    const result = runTurnEndPipeline({
      messages,
      turn: 1,
      budget,
      userTask: { role: 'user', content: 'task' },
      contextPolicy: policy,
    });
    assert.equal(result.heavy_compression, false);
    assert.equal(result.pruned, 0);
  });

  it('triggers heavy earlier with lower first_ratio on turn > 1', () => {
    const policy = normalizeContextPolicy({
      heavy_compression: { first_ratio: 0.5, repeat_ratio: 0.6 },
    });
    const budget = createBudgetConfig('unknown', policy);
    // Place just above 50% usable, below default 80%
    const usable = usableContextTokens(budget);
    const target = Math.floor(usable * 0.55);
    const messages: ChatMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: fillerTokens(target) },
    ];

    assert.equal(
      shouldRunHeavyCompression(
        // raw estimate path without calibrator — pipeline uses estimateTokens(visible)
        // which is close to filler target
        target,
        budget,
        false,
      ),
      true,
    );

    const defaultBudget = createBudgetConfig('unknown');
    assert.equal(
      shouldRunHeavyCompression(target, defaultBudget, false),
      false,
    );

    const result = runTurnEndPipeline({
      messages,
      turn: 3,
      budget,
      userTask: { role: 'user', content: 'task' },
      contextPolicy: policy,
    });
    assert.equal(result.heavy_compression, true);
  });
});
