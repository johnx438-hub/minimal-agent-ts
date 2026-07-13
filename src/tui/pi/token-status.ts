/**
 * Status-bar token metrics: session billed (main vs spawn) + last main-agent
 * context + prefix-cache hit rate. Driven by llm_done.usage / .cache (API-reported).
 */

export interface ParsedUsageTokens {
  prompt?: number;
  completion?: number;
  /** total_tokens, or prompt+completion when total missing. */
  billed?: number;
}

/** Subset of LlmCacheStats needed for hit-rate tracking. */
export interface CacheUsageInput {
  cached_tokens?: number;
  cache_miss_tokens?: number;
  prompt_tokens?: number;
}

function asFiniteNonNeg(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return Math.max(0, Math.floor(value));
}

/** Pull prompt / completion / billed counts from OpenAI-style usage objects. */
export function readUsageTokens(usage: unknown): ParsedUsageTokens {
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) return {};
  const u = usage as Record<string, unknown>;
  const prompt = asFiniteNonNeg(u.prompt_tokens);
  const completion = asFiniteNonNeg(u.completion_tokens);
  let billed = asFiniteNonNeg(u.total_tokens);
  if (billed === undefined && (prompt !== undefined || completion !== undefined)) {
    billed = (prompt ?? 0) + (completion ?? 0);
  }
  return { prompt, completion, billed };
}

/**
 * Derive (hit, eligible) tokens for one turn.
 * Prefer hit+miss (DeepSeek); else hit vs prompt_tokens (OpenAI-style details).
 */
export function readCacheHitSample(
  cache: CacheUsageInput | undefined,
  usagePromptTokens?: number,
): { hit: number; eligible: number } | undefined {
  if (!cache) return undefined;
  const hit = asFiniteNonNeg(cache.cached_tokens);
  const miss = asFiniteNonNeg(cache.cache_miss_tokens);
  const prompt =
    asFiniteNonNeg(cache.prompt_tokens) ?? asFiniteNonNeg(usagePromptTokens);

  if (hit !== undefined && miss !== undefined) {
    const eligible = hit + miss;
    if (eligible <= 0) return undefined;
    return { hit, eligible };
  }
  if (hit !== undefined && prompt !== undefined && prompt > 0) {
    // Cap hit at prompt in case of vendor quirks.
    return { hit: Math.min(hit, prompt), eligible: prompt };
  }
  if (hit !== undefined && hit > 0 && miss === undefined && prompt === undefined) {
    // Only hit reported — cannot form a ratio yet.
    return undefined;
  }
  return undefined;
}

/** Drop trailing ".0" from fixed-1 strings. */
function trimOneDecimal(n: number): string {
  const s = n.toFixed(1);
  return s.endsWith('.0') ? s.slice(0, -2) : s;
}

/** Compact display: 999 → "999", 1500 → "1.5k", 17300 → "17.3k", 1.2e6 → "1.2M". */
export function formatCompactTokens(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '0';
  const v = Math.floor(n);
  if (v < 1_000) return String(v);
  if (v < 100_000) {
    return `${trimOneDecimal(v / 1_000)}k`;
  }
  if (v < 1_000_000) return `${Math.round(v / 1_000)}k`;
  if (v < 10_000_000) return `${trimOneDecimal(v / 1_000_000)}M`;
  return `${Math.round(v / 1_000_000)}M`;
}

/** Integer percent 0–100; undefined when no samples. */
export function formatCacheHitPercent(hit: number, eligible: number): string | undefined {
  if (!Number.isFinite(eligible) || eligible <= 0) return undefined;
  const pct = Math.round((Math.max(0, hit) / eligible) * 100);
  return `${Math.min(100, Math.max(0, pct))}%`;
}

/**
 * Accumulates session token usage for the TUI footer.
 * - Σm / Σs: billed tokens for main agent vs spawn children (spawn_start/end gated)
 * - ctx: last prompt_tokens from main-agent turns only
 * - c: session prefix-cache hit% (all turns with cache telemetry)
 */
export class TokenStatusTracker {
  mainBilled = 0;
  spawnBilled = 0;
  lastContext: number | undefined;
  /** Sum of cached_tokens across turns with usable cache stats. */
  cacheHitTokens = 0;
  /** Sum of (hit+miss) or prompt denominators for those turns. */
  cacheEligibleTokens = 0;
  private activeSpawns = 0;
  private sessionKey = '';

  /** Main + spawn billed total. */
  get totalBilled(): number {
    return this.mainBilled + this.spawnBilled;
  }

  /** Session cache hit rate 0–1, or undefined when no cache samples. */
  get cacheHitRate(): number | undefined {
    if (this.cacheEligibleTokens <= 0) return undefined;
    return this.cacheHitTokens / this.cacheEligibleTokens;
  }

  /** Reset counters when the active session id changes. */
  bindSession(sessionKey: string): void {
    const key = sessionKey.trim();
    if (key === this.sessionKey) return;
    this.sessionKey = key;
    this.reset();
  }

  reset(): void {
    this.mainBilled = 0;
    this.spawnBilled = 0;
    this.lastContext = undefined;
    this.cacheHitTokens = 0;
    this.cacheEligibleTokens = 0;
    this.activeSpawns = 0;
  }

  onSpawnStart(): void {
    this.activeSpawns += 1;
  }

  onSpawnEnd(): void {
    this.activeSpawns = Math.max(0, this.activeSpawns - 1);
  }

  onLlmDone(usage: unknown, cache?: CacheUsageInput): boolean {
    const parsed = readUsageTokens(usage);
    let changed = false;
    if (parsed.billed !== undefined && parsed.billed > 0) {
      if (this.activeSpawns > 0) {
        this.spawnBilled += parsed.billed;
      } else {
        this.mainBilled += parsed.billed;
      }
      changed = true;
    }
    // Only main-agent prompt size is "agent context" occupancy.
    if (parsed.prompt !== undefined && this.activeSpawns === 0) {
      if (this.lastContext !== parsed.prompt) {
        this.lastContext = parsed.prompt;
        changed = true;
      }
    }

    const sample = readCacheHitSample(cache, parsed.prompt);
    if (sample) {
      this.cacheHitTokens += sample.hit;
      this.cacheEligibleTokens += sample.eligible;
      changed = true;
    }
    return changed;
  }

  /**
   * Status fragment, e.g. `Σm:12.3k · Σs:1k · ctx:8.1k/1.0M · c:72%`.
   * Σs / c omitted when zero / no samples. Empty when no usage yet.
   */
  formatStatus(contextLimit?: number): string {
    if (
      this.totalBilled <= 0 &&
      this.lastContext === undefined &&
      this.cacheEligibleTokens <= 0
    ) {
      return '';
    }
    const parts: string[] = [];
    if (this.mainBilled > 0 || this.spawnBilled > 0) {
      if (this.mainBilled > 0 || this.spawnBilled === 0) {
        parts.push(`Σm:${formatCompactTokens(this.mainBilled)}`);
      }
      if (this.spawnBilled > 0) {
        parts.push(`Σs:${formatCompactTokens(this.spawnBilled)}`);
      }
    }
    if (this.lastContext !== undefined) {
      let ctx = `ctx:${formatCompactTokens(this.lastContext)}`;
      if (contextLimit !== undefined && contextLimit > 0) {
        ctx += `/${formatCompactTokens(contextLimit)}`;
      }
      parts.push(ctx);
    }
    const hitPct = formatCacheHitPercent(this.cacheHitTokens, this.cacheEligibleTokens);
    if (hitPct) {
      parts.push(`c:${hitPct}`);
    }
    return parts.join(' · ');
  }
}
