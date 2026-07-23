/**
 * Session-scoped EWMA scale: maps local char-based token estimates toward
 * API-reported prompt_tokens so budget decisions track real context occupancy.
 *
 * Default scale=1 → bit-identical to uncalibrated estimateTokens paths.
 */

export const DEFAULT_CALIBRATOR_ALPHA = 0.3;
export const DEFAULT_SCALE_MIN = 0.5;
export const DEFAULT_SCALE_MAX = 2.0;
/** Ignore ratio samples when local estimate is this small (noisy). */
export const DEFAULT_MIN_RAW = 256;

export interface TokenCalibratorOptions {
  alpha?: number;
  min?: number;
  max?: number;
  minRaw?: number;
}

export interface TokenCalibratorSnapshot {
  scale: number;
  samples: number;
  lastSample?: number;
  lastActual?: number;
  lastRaw?: number;
}

/** Clamp sample ratio; returns undefined when inputs are unusable. */
export function ratioSample(
  raw: number,
  actual: number,
  minRaw: number = DEFAULT_MIN_RAW,
): number | undefined {
  if (!Number.isFinite(raw) || !Number.isFinite(actual)) return undefined;
  if (raw < minRaw || actual <= 0) return undefined;
  return actual / raw;
}

export function ewmaUpdate(
  prev: number,
  sample: number,
  alpha: number,
  min: number,
  max: number,
): number {
  const a = Number.isFinite(alpha) ? Math.min(1, Math.max(0, alpha)) : DEFAULT_CALIBRATOR_ALPHA;
  const next = a * sample + (1 - a) * prev;
  if (!Number.isFinite(next)) return prev;
  return Math.min(max, Math.max(min, next));
}

export class TokenCalibrator {
  private scale = 1;
  private samples = 0;
  private lastSample: number | undefined;
  private lastActual: number | undefined;
  private lastRaw: number | undefined;
  private readonly alpha: number;
  private readonly min: number;
  private readonly max: number;
  private readonly minRaw: number;

  constructor(opts?: TokenCalibratorOptions) {
    this.alpha =
      opts?.alpha !== undefined && Number.isFinite(opts.alpha)
        ? Math.min(1, Math.max(0, opts.alpha))
        : DEFAULT_CALIBRATOR_ALPHA;
    this.min =
      opts?.min !== undefined && Number.isFinite(opts.min)
        ? opts.min
        : DEFAULT_SCALE_MIN;
    this.max =
      opts?.max !== undefined && Number.isFinite(opts.max)
        ? opts.max
        : DEFAULT_SCALE_MAX;
    this.minRaw =
      opts?.minRaw !== undefined && Number.isFinite(opts.minRaw) && opts.minRaw > 0
        ? opts.minRaw
        : DEFAULT_MIN_RAW;
  }

  /**
   * Observe one LLM turn: local raw estimate vs API prompt_tokens.
   * Invalid samples are ignored (scale unchanged).
   */
  observe(raw: number, actual: number): void {
    const sample = ratioSample(raw, actual, this.minRaw);
    if (sample === undefined) return;
    this.scale = ewmaUpdate(this.scale, sample, this.alpha, this.min, this.max);
    this.samples += 1;
    this.lastSample = sample;
    this.lastActual = actual;
    this.lastRaw = raw;
    if (process.env.DEBUG_TOKEN_CAL === '1') {
      console.error(
        `[token_cal] raw=${Math.round(raw)} actual=${Math.round(actual)} ` +
          `sample=${sample.toFixed(3)} scale=${this.scale.toFixed(3)} n=${this.samples}`,
      );
    }
  }

  getScale(): number {
    return this.scale;
  }

  /** ceil(raw * scale); non-positive raw → 0. */
  apply(raw: number): number {
    if (!Number.isFinite(raw) || raw <= 0) return 0;
    return Math.ceil(raw * this.scale);
  }

  reset(): void {
    this.scale = 1;
    this.samples = 0;
    this.lastSample = undefined;
    this.lastActual = undefined;
    this.lastRaw = undefined;
  }

  snapshot(): TokenCalibratorSnapshot {
    return {
      scale: this.scale,
      samples: this.samples,
      ...(this.lastSample !== undefined ? { lastSample: this.lastSample } : {}),
      ...(this.lastActual !== undefined ? { lastActual: this.lastActual } : {}),
      ...(this.lastRaw !== undefined ? { lastRaw: this.lastRaw } : {}),
    };
  }
}

/** Pull prompt_tokens from OpenAI-style usage (no TUI dependency). */
export function readPromptTokensFromUsage(usage: unknown): number | undefined {
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) return undefined;
  const v = (usage as Record<string, unknown>).prompt_tokens;
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return undefined;
  return Math.floor(v);
}
