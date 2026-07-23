import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  CHARS_PER_TOKEN,
  DEFAULT_BUDGET,
  FIRST_HEAVY_COMPRESSION_RATIO,
  MIN_RESUME_HISTORY_TOKENS,
  REPEAT_HEAVY_COMPRESSION_RATIO,
} from '../src/context/budget.js';
import { PROTECT_RECENT_TOKENS, PROTECT_USER_TURNS } from '../src/context/estimate.js';
import {
  defaultResolvedContextPolicy,
  mergeContextPolicy,
  normalizeContextPolicy,
} from '../src/context/policy-config.js';
import { MAX_POINTER_COMPACT_PER_TURN } from '../src/context/pointer-compact.js';
import { PRUNE_MIN_SAVINGS } from '../src/context/prune.js';
import {
  DEFAULT_CALIBRATOR_ALPHA,
  DEFAULT_MIN_RAW,
  DEFAULT_SCALE_MAX,
  DEFAULT_SCALE_MIN,
} from '../src/context/token-calibrator.js';
import {
  defaultAgentPluginConfig,
  loadAgentPluginConfig,
} from '../src/plugins/config-loader.js';

describe('defaultResolvedContextPolicy parity with hardcodes', () => {
  it('mirrors budget / estimate / prune / calibrator constants', () => {
    const d = defaultResolvedContextPolicy();
    assert.equal(d.budget.system_pct, DEFAULT_BUDGET.system_pct);
    assert.equal(d.budget.current_pct, DEFAULT_BUDGET.current_pct);
    assert.equal(d.budget.recent_pct, DEFAULT_BUDGET.recent_pct);
    assert.equal(d.budget.mid_pct, DEFAULT_BUDGET.mid_pct);
    assert.equal(d.budget.early_pct, DEFAULT_BUDGET.early_pct);
    assert.equal(d.budget.recent_max_tokens, DEFAULT_BUDGET.recent_max_tokens);
    assert.equal(d.budget.mid_max_summaries, DEFAULT_BUDGET.mid_max_summaries);
    assert.equal(d.heavy_compression.first_ratio, FIRST_HEAVY_COMPRESSION_RATIO);
    assert.equal(d.heavy_compression.repeat_ratio, REPEAT_HEAVY_COMPRESSION_RATIO);
    assert.equal(d.protect.recent_tokens, PROTECT_RECENT_TOKENS);
    assert.equal(d.protect.user_turns, PROTECT_USER_TURNS);
    assert.equal(d.prune.min_savings_tokens, PRUNE_MIN_SAVINGS);
    assert.equal(d.prune.max_pointer_compact_per_turn, MAX_POINTER_COMPACT_PER_TURN);
    assert.equal(d.token_calibrator.alpha, DEFAULT_CALIBRATOR_ALPHA);
    assert.equal(d.token_calibrator.scale_min, DEFAULT_SCALE_MIN);
    assert.equal(d.token_calibrator.scale_max, DEFAULT_SCALE_MAX);
    assert.equal(d.token_calibrator.min_raw, DEFAULT_MIN_RAW);
    assert.equal(d.estimate.chars_per_token, CHARS_PER_TOKEN);
    assert.equal(d.resume.min_history_tokens, MIN_RESUME_HISTORY_TOKENS);
    assert.equal(d.resume.apply_calibrator, false);
  });
});

describe('normalizeContextPolicy', () => {
  it('undefined / null → full defaults (omit ≡ code)', () => {
    assert.deepEqual(normalizeContextPolicy(undefined), defaultResolvedContextPolicy());
    assert.deepEqual(normalizeContextPolicy(null), defaultResolvedContextPolicy());
    assert.deepEqual(normalizeContextPolicy({}), defaultResolvedContextPolicy());
  });

  it('clamps first_ratio above max to 0.95', () => {
    const r = normalizeContextPolicy({
      heavy_compression: { first_ratio: 1.5 },
    });
    assert.equal(r.heavy_compression.first_ratio, 0.95);
  });

  it('raises repeat_ratio to at least first_ratio', () => {
    const r = normalizeContextPolicy({
      heavy_compression: { first_ratio: 0.85, repeat_ratio: 0.6 },
    });
    assert.equal(r.heavy_compression.first_ratio, 0.85);
    assert.equal(r.heavy_compression.repeat_ratio, 0.85);
  });

  it('clamps scale_max into [1, 4] and scale_min into (0, 1]', () => {
    // SPEC: scale_min ≤ 1 ≤ scale_max after clamp → max always ≥ min
    const r = normalizeContextPolicy({
      token_calibrator: { scale_min: 0.01, scale_max: 10 },
    });
    assert.equal(r.token_calibrator.scale_min, 0.05);
    assert.equal(r.token_calibrator.scale_max, 4);
  });

  it('ignores non-finite numbers and keeps defaults', () => {
    const r = normalizeContextPolicy({
      budget: {
        system_pct: Number.NaN,
        recent_max_tokens: Number.POSITIVE_INFINITY,
      },
      prune: { min_savings_tokens: 'nope' as unknown as number },
    });
    const d = defaultResolvedContextPolicy();
    assert.equal(r.budget.system_pct, d.budget.system_pct);
    assert.equal(r.budget.recent_max_tokens, d.budget.recent_max_tokens);
    assert.equal(r.prune.min_savings_tokens, d.prune.min_savings_tokens);
  });

  it('applies valid partial overrides only', () => {
    const r = normalizeContextPolicy({
      heavy_compression: { first_ratio: 0.55 },
      protect: { user_turns: 4 },
    });
    assert.equal(r.heavy_compression.first_ratio, 0.55);
    assert.equal(r.heavy_compression.repeat_ratio, REPEAT_HEAVY_COMPRESSION_RATIO);
    assert.equal(r.protect.user_turns, 4);
    assert.equal(r.protect.recent_tokens, PROTECT_RECENT_TOKENS);
  });
});

describe('mergeContextPolicy', () => {
  it('deep-merges nested knobs without dropping siblings', () => {
    const merged = mergeContextPolicy(
      {
        heavy_compression: { first_ratio: 0.7, repeat_ratio: 0.85 },
        protect: { user_turns: 3 },
      },
      {
        heavy_compression: { first_ratio: 0.6 },
        prune: { min_savings_tokens: 10_000 },
      },
    );
    assert.deepEqual(merged, {
      heavy_compression: { first_ratio: 0.6, repeat_ratio: 0.85 },
      protect: { user_turns: 3 },
      prune: { min_savings_tokens: 10_000 },
    });
  });

  it('undefined base + patch returns patch copy', () => {
    const patch = { protect: { user_turns: 1 } };
    const merged = mergeContextPolicy(undefined, patch);
    assert.deepEqual(merged, patch);
    assert.notEqual(merged, patch);
  });
});

describe('loadAgentPluginConfig + context_policy', () => {
  it('default config has no context_policy (runtime still uses code defaults)', () => {
    const cfg = defaultAgentPluginConfig();
    assert.equal(cfg.context_policy, undefined);
  });

  it('loads and deep-merges context_policy from agent.json without breaking other fields', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ctx-policy-'));
    writeFileSync(
      join(dir, 'agent.json'),
      JSON.stringify({
        pointerize_policy: { keep_inline_turns: 5 },
        context_policy: {
          heavy_compression: { first_ratio: 0.55 },
          token_calibrator: { alpha: 0.5 },
        },
      }),
      'utf8',
    );

    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = 'test';
    try {
      const cfg = loadAgentPluginConfig(dir);
      assert.equal(cfg.pointerize_policy?.keep_inline_turns, 5);
      // preview defaults from defaultAgentPluginConfig still present
      assert.equal(cfg.pointerize_policy?.preview_mode, 'smart');
      assert.equal(cfg.context_policy?.heavy_compression?.first_ratio, 0.55);
      assert.equal(cfg.context_policy?.token_calibrator?.alpha, 0.5);
      // not yet applied to runtime — normalize is call-site
      const resolved = normalizeContextPolicy(cfg.context_policy);
      assert.equal(resolved.heavy_compression.first_ratio, 0.55);
      assert.equal(resolved.token_calibrator.alpha, 0.5);
      assert.equal(resolved.heavy_compression.repeat_ratio, REPEAT_HEAVY_COMPRESSION_RATIO);
    } finally {
      process.env.NODE_ENV = prev;
    }
  });
});
