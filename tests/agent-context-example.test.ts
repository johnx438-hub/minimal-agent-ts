import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  createBudgetConfig,
  FIRST_HEAVY_COMPRESSION_RATIO,
  heavyCompressionThreshold,
  REPEAT_HEAVY_COMPRESSION_RATIO,
} from '../src/context/budget.js';
import {
  normalizeContextPolicy,
  tokenCalibratorOptionsFromPolicy,
} from '../src/context/policy-config.js';
import { TokenCalibrator } from '../src/context/token-calibrator.js';
import type { ContextPolicy } from '../src/plugins/types.js';

const EXAMPLE_PATH = join(import.meta.dirname, '..', 'agent.context.example.json');

function loadExample(): {
  context_policy?: ContextPolicy;
  pointerize_policy?: Record<string, unknown>;
  _profiles?: Record<string, ContextPolicy>;
} {
  return JSON.parse(readFileSync(EXAMPLE_PATH, 'utf8')) as {
    context_policy?: ContextPolicy;
    pointerize_policy?: Record<string, unknown>;
    _profiles?: Record<string, ContextPolicy>;
  };
}

describe('agent.context.example.json', () => {
  it('parses and default context_policy normalizes to code defaults', () => {
    const example = loadExample();
    assert.ok(example.context_policy);
    const resolved = normalizeContextPolicy(example.context_policy);
    const empty = normalizeContextPolicy(undefined);

    assert.deepEqual(resolved.heavy_compression, empty.heavy_compression);
    assert.deepEqual(resolved.protect, empty.protect);
    assert.deepEqual(resolved.prune, empty.prune);
    assert.deepEqual(resolved.token_calibrator, empty.token_calibrator);
    assert.equal(resolved.heavy_compression.first_ratio, FIRST_HEAVY_COMPRESSION_RATIO);
    assert.equal(resolved.heavy_compression.repeat_ratio, REPEAT_HEAVY_COMPRESSION_RATIO);
  });

  it('pointerize_policy documents keep + soft_force', () => {
    const example = loadExample();
    assert.equal(example.pointerize_policy?.keep_inline_turns, 2);
    assert.equal(example.pointerize_policy?.soft_force_ratio, 0.75);
    const overrides = example.pointerize_policy?.tool_overrides as
      | Record<string, { mode?: string }>
      | undefined;
    assert.equal(overrides?.recall_query?.mode, 'never');
  });

  it('aggressive_compression profile lowers heavy threshold vs default', () => {
    const example = loadExample();
    const aggressive = normalizeContextPolicy(example._profiles?.aggressive_compression);
    const base = createBudgetConfig('unknown');
    const agBudget = createBudgetConfig('unknown', aggressive);
    assert.ok(
      heavyCompressionThreshold(agBudget, false) < heavyCompressionThreshold(base, false),
    );
    assert.equal(aggressive.heavy_compression.first_ratio, 0.55);
  });

  it('fast_calibrator profile wires TokenCalibrator alpha=1 (C3)', () => {
    const example = loadExample();
    const policy = normalizeContextPolicy(example._profiles?.fast_calibrator);
    assert.equal(policy.token_calibrator.alpha, 1);
    const cal = new TokenCalibrator(tokenCalibratorOptionsFromPolicy(policy));
    cal.observe(1000, 1500);
    assert.equal(cal.getScale(), 1.5);
  });
});
