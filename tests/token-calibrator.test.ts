import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  DEFAULT_CALIBRATOR_ALPHA,
  DEFAULT_SCALE_MAX,
  DEFAULT_SCALE_MIN,
  TokenCalibrator,
  ewmaUpdate,
  ratioSample,
  readPromptTokensFromUsage,
} from '../src/context/token-calibrator.js';

describe('ratioSample', () => {
  it('returns actual/raw when raw is large enough', () => {
    assert.equal(ratioSample(1000, 1500), 1.5);
  });

  it('ignores small raw estimates', () => {
    assert.equal(ratioSample(100, 200, 256), undefined);
  });

  it('ignores non-positive actual', () => {
    assert.equal(ratioSample(1000, 0), undefined);
    assert.equal(ratioSample(1000, -1), undefined);
  });

  it('ignores non-finite inputs', () => {
    assert.equal(ratioSample(Number.NaN, 1000), undefined);
    assert.equal(ratioSample(1000, Number.POSITIVE_INFINITY), undefined);
  });
});

describe('ewmaUpdate', () => {
  it('moves toward sample by alpha', () => {
    // 0.3 * 1.5 + 0.7 * 1 = 1.15
    assert.equal(ewmaUpdate(1, 1.5, 0.3, 0.5, 2), 1.15);
  });

  it('clamps to max and min', () => {
    assert.equal(ewmaUpdate(1, 10, 1, 0.5, 2), 2);
    assert.equal(ewmaUpdate(1, 0.01, 1, 0.5, 2), 0.5);
  });
});

describe('TokenCalibrator', () => {
  it('starts at scale 1 and identity apply', () => {
    const c = new TokenCalibrator();
    assert.equal(c.getScale(), 1);
    assert.equal(c.apply(1000), 1000);
    assert.equal(c.snapshot().samples, 0);
  });

  it('observe moves scale toward ratio (alpha=0.3)', () => {
    const c = new TokenCalibrator({ alpha: DEFAULT_CALIBRATOR_ALPHA });
    c.observe(1000, 1500);
    assert.ok(Math.abs(c.getScale() - 1.15) < 1e-9);
    assert.equal(c.apply(1000), Math.ceil(1000 * 1.15));
    assert.equal(c.snapshot().samples, 1);
    assert.equal(c.snapshot().lastSample, 1.5);
  });

  it('converges toward a stable ratio', () => {
    const c = new TokenCalibrator({ alpha: 0.3 });
    for (let i = 0; i < 40; i++) {
      c.observe(10_000, 15_000);
    }
    assert.ok(Math.abs(c.getScale() - 1.5) < 0.02);
  });

  it('clamps extreme samples', () => {
    const c = new TokenCalibrator({ alpha: 1, min: DEFAULT_SCALE_MIN, max: DEFAULT_SCALE_MAX });
    c.observe(1000, 20_000);
    assert.equal(c.getScale(), DEFAULT_SCALE_MAX);
    c.reset();
    c.observe(1000, 50);
    assert.equal(c.getScale(), DEFAULT_SCALE_MIN);
  });

  it('ignores raw below minRaw', () => {
    const c = new TokenCalibrator({ minRaw: 256 });
    c.observe(100, 500);
    assert.equal(c.getScale(), 1);
    assert.equal(c.snapshot().samples, 0);
  });

  it('ignores invalid actual', () => {
    const c = new TokenCalibrator();
    c.observe(1000, 0);
    c.observe(1000, Number.NaN);
    assert.equal(c.getScale(), 1);
    assert.equal(c.snapshot().samples, 0);
  });

  it('reset restores identity', () => {
    const c = new TokenCalibrator({ alpha: 1 });
    c.observe(1000, 1500);
    assert.ok(c.getScale() !== 1);
    c.reset();
    assert.equal(c.getScale(), 1);
    assert.equal(c.snapshot().samples, 0);
  });

  it('apply returns 0 for non-positive raw', () => {
    const c = new TokenCalibrator();
    assert.equal(c.apply(0), 0);
    assert.equal(c.apply(-10), 0);
  });
});

describe('readPromptTokensFromUsage', () => {
  it('reads finite non-negative prompt_tokens', () => {
    assert.equal(readPromptTokensFromUsage({ prompt_tokens: 1200 }), 1200);
    assert.equal(readPromptTokensFromUsage({ prompt_tokens: 12.9 }), 12);
  });

  it('returns undefined for missing or bad usage', () => {
    assert.equal(readPromptTokensFromUsage(null), undefined);
    assert.equal(readPromptTokensFromUsage({}), undefined);
    assert.equal(readPromptTokensFromUsage({ prompt_tokens: -1 }), undefined);
  });
});
