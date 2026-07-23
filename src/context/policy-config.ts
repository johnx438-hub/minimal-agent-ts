/**
 * context_policy load helpers (SPEC_CONTEXT_POLICY).
 *
 * Defaults are imported from existing hard-coded constants so omit ≡ current
 * behavior. normalizeContextPolicy clamps bad JSON.
 * C2: createBudgetConfig / pipeline / TokenCalibrator consume ResolvedContextPolicy.
 */

import {
  CHARS_PER_TOKEN,
  DEFAULT_BUDGET,
  FIRST_HEAVY_COMPRESSION_RATIO,
  MIN_RESUME_HISTORY_TOKENS,
  REPEAT_HEAVY_COMPRESSION_RATIO,
} from './budget.js';
import { PROTECT_RECENT_TOKENS, PROTECT_USER_TURNS } from './estimate.js';
import { MAX_POINTER_COMPACT_PER_TURN } from './pointer-compact.js';
import { PRUNE_MIN_SAVINGS } from './prune.js';
import {
  DEFAULT_CALIBRATOR_ALPHA,
  DEFAULT_MIN_RAW,
  DEFAULT_SCALE_MAX,
  DEFAULT_SCALE_MIN,
  type TokenCalibratorOptions,
} from './token-calibrator.js';
import type { ContextPolicy } from '../plugins/types.js';

/** Fully filled policy after defaults + clamp (safe for runtime consumers). */
export interface ResolvedContextPolicy {
  budget: {
    system_pct: number;
    current_pct: number;
    recent_pct: number;
    mid_pct: number;
    early_pct: number;
    recent_max_tokens: number;
    mid_max_summaries: number;
  };
  heavy_compression: {
    first_ratio: number;
    repeat_ratio: number;
  };
  protect: {
    recent_tokens: number;
    user_turns: number;
  };
  prune: {
    min_savings_tokens: number;
    max_pointer_compact_per_turn: number;
  };
  token_calibrator: {
    alpha: number;
    scale_min: number;
    scale_max: number;
    min_raw: number;
  };
  estimate: {
    chars_per_token: number;
  };
  resume: {
    min_history_tokens: number;
    apply_calibrator: boolean;
  };
}

/** Snapshot of code defaults (parity with budget/estimate/prune/calibrator). */
export function defaultResolvedContextPolicy(): ResolvedContextPolicy {
  return {
    budget: {
      system_pct: DEFAULT_BUDGET.system_pct,
      current_pct: DEFAULT_BUDGET.current_pct,
      recent_pct: DEFAULT_BUDGET.recent_pct,
      mid_pct: DEFAULT_BUDGET.mid_pct,
      early_pct: DEFAULT_BUDGET.early_pct,
      recent_max_tokens: DEFAULT_BUDGET.recent_max_tokens,
      mid_max_summaries: DEFAULT_BUDGET.mid_max_summaries,
    },
    heavy_compression: {
      first_ratio: FIRST_HEAVY_COMPRESSION_RATIO,
      repeat_ratio: REPEAT_HEAVY_COMPRESSION_RATIO,
    },
    protect: {
      recent_tokens: PROTECT_RECENT_TOKENS,
      user_turns: PROTECT_USER_TURNS,
    },
    prune: {
      min_savings_tokens: PRUNE_MIN_SAVINGS,
      max_pointer_compact_per_turn: MAX_POINTER_COMPACT_PER_TURN,
    },
    token_calibrator: {
      alpha: DEFAULT_CALIBRATOR_ALPHA,
      scale_min: DEFAULT_SCALE_MIN,
      scale_max: DEFAULT_SCALE_MAX,
      min_raw: DEFAULT_MIN_RAW,
    },
    estimate: {
      chars_per_token: CHARS_PER_TOKEN,
    },
    resume: {
      min_history_tokens: MIN_RESUME_HISTORY_TOKENS,
      apply_calibrator: false,
    },
  };
}

function asFiniteNumber(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return value;
}

function clampNumber(
  value: unknown,
  min: number,
  max: number,
  fallback: number,
): number {
  const n = asFiniteNumber(value);
  if (n === undefined) return fallback;
  return Math.min(max, Math.max(min, n));
}

function clampInt(
  value: unknown,
  min: number,
  max: number,
  fallback: number,
): number {
  return Math.floor(clampNumber(value, min, max, fallback));
}

function mergeSubPolicy<T extends object>(
  base: T | undefined,
  patch: T | undefined,
): T | undefined {
  if (!base && !patch) return undefined;
  if (!patch) return base ? { ...base } : undefined;
  if (!base) return { ...patch };
  return { ...base, ...patch };
}

/**
 * Merge partial context_policy patches (deep on known sub-objects).
 * Used by agent.json loader; does not clamp (call normalize after load).
 * Omits empty sub-objects so JSON patches do not invent `{}` siblings.
 */
export function mergeContextPolicy(
  base: ContextPolicy | undefined,
  patch: ContextPolicy | undefined,
): ContextPolicy | undefined {
  if (!base && !patch) return undefined;
  if (!patch) return base ? { ...base } : undefined;

  const left = base ?? {};
  const out: ContextPolicy = { ...left, ...patch };
  const budget = mergeSubPolicy(left.budget, patch.budget);
  const heavy = mergeSubPolicy(left.heavy_compression, patch.heavy_compression);
  const protect = mergeSubPolicy(left.protect, patch.protect);
  const prune = mergeSubPolicy(left.prune, patch.prune);
  const cal = mergeSubPolicy(left.token_calibrator, patch.token_calibrator);
  const estimate = mergeSubPolicy(left.estimate, patch.estimate);
  const resume = mergeSubPolicy(left.resume, patch.resume);

  if (budget) out.budget = budget;
  else delete out.budget;
  if (heavy) out.heavy_compression = heavy;
  else delete out.heavy_compression;
  if (protect) out.protect = protect;
  else delete out.protect;
  if (prune) out.prune = prune;
  else delete out.prune;
  if (cal) out.token_calibrator = cal;
  else delete out.token_calibrator;
  if (estimate) out.estimate = estimate;
  else delete out.estimate;
  if (resume) out.resume = resume;
  else delete out.resume;

  return out;
}

/**
 * Fill defaults from code constants and clamp out-of-range JSON values.
 * Invalid / missing fields fall back to defaults (never throw).
 */
export function normalizeContextPolicy(
  raw?: ContextPolicy | null,
): ResolvedContextPolicy {
  const d = defaultResolvedContextPolicy();
  if (!raw || typeof raw !== 'object') {
    return d;
  }

  const budgetIn = raw.budget ?? {};
  const heavyIn = raw.heavy_compression ?? {};
  const protectIn = raw.protect ?? {};
  const pruneIn = raw.prune ?? {};
  const calIn = raw.token_calibrator ?? {};
  const estIn = raw.estimate ?? {};
  const resumeIn = raw.resume ?? {};

  const first_ratio = clampNumber(
    heavyIn.first_ratio,
    0.5,
    0.95,
    d.heavy_compression.first_ratio,
  );
  let repeat_ratio = clampNumber(
    heavyIn.repeat_ratio,
    0.5,
    0.98,
    d.heavy_compression.repeat_ratio,
  );
  if (repeat_ratio < first_ratio) {
    repeat_ratio = first_ratio;
  }

  let scale_min = clampNumber(calIn.scale_min, 0.05, 1, d.token_calibrator.scale_min);
  let scale_max = clampNumber(calIn.scale_max, 1, 4, d.token_calibrator.scale_max);
  if (scale_max < scale_min) {
    scale_max = scale_min;
  }

  return {
    budget: {
      system_pct: clampNumber(budgetIn.system_pct, 0.001, 0.3, d.budget.system_pct),
      current_pct: clampNumber(budgetIn.current_pct, 0.001, 0.4, d.budget.current_pct),
      recent_pct: clampNumber(budgetIn.recent_pct, 0.001, 0.8, d.budget.recent_pct),
      mid_pct: clampNumber(budgetIn.mid_pct, 0.001, 0.8, d.budget.mid_pct),
      early_pct: clampNumber(budgetIn.early_pct, 0.001, 0.5, d.budget.early_pct),
      recent_max_tokens: clampInt(
        budgetIn.recent_max_tokens,
        1000,
        10_000_000,
        d.budget.recent_max_tokens,
      ),
      mid_max_summaries: clampInt(
        budgetIn.mid_max_summaries,
        1,
        200,
        d.budget.mid_max_summaries,
      ),
    },
    heavy_compression: { first_ratio, repeat_ratio },
    protect: {
      recent_tokens: clampInt(
        protectIn.recent_tokens,
        1000,
        10_000_000,
        d.protect.recent_tokens,
      ),
      user_turns: clampInt(protectIn.user_turns, 0, 20, d.protect.user_turns),
    },
    prune: {
      min_savings_tokens: clampInt(
        pruneIn.min_savings_tokens,
        0,
        10_000_000,
        d.prune.min_savings_tokens,
      ),
      max_pointer_compact_per_turn: clampInt(
        pruneIn.max_pointer_compact_per_turn,
        1,
        200,
        d.prune.max_pointer_compact_per_turn,
      ),
    },
    token_calibrator: {
      alpha: clampNumber(calIn.alpha, 0, 1, d.token_calibrator.alpha),
      scale_min,
      scale_max,
      min_raw: clampInt(calIn.min_raw, 1, 1_000_000, d.token_calibrator.min_raw),
    },
    estimate: {
      chars_per_token: clampNumber(
        estIn.chars_per_token,
        0.5,
        8,
        d.estimate.chars_per_token,
      ),
    },
    resume: {
      min_history_tokens: clampInt(
        resumeIn.min_history_tokens,
        0,
        10_000_000,
        d.resume.min_history_tokens,
      ),
      apply_calibrator:
        typeof resumeIn.apply_calibrator === 'boolean'
          ? resumeIn.apply_calibrator
          : d.resume.apply_calibrator,
    },
  };
}

/** Map resolved policy → TokenCalibrator constructor options. */
export function tokenCalibratorOptionsFromPolicy(
  policy: ResolvedContextPolicy,
): TokenCalibratorOptions {
  return {
    alpha: policy.token_calibrator.alpha,
    min: policy.token_calibrator.scale_min,
    max: policy.token_calibrator.scale_max,
    minRaw: policy.token_calibrator.min_raw,
  };
}
