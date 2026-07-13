/**
 * Status-bar token metrics: session total billed + last main-agent context size.
 * Driven by llm_done.usage (API-reported), not local estimates.
 */

export interface ParsedUsageTokens {
  prompt?: number;
  completion?: number;
  /** total_tokens, or prompt+completion when total missing. */
  billed?: number;
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
    // Keep one decimal under 100k so status bar can show e.g. 17.3k.
    return `${trimOneDecimal(v / 1_000)}k`;
  }
  if (v < 1_000_000) return `${Math.round(v / 1_000)}k`;
  if (v < 10_000_000) return `${trimOneDecimal(v / 1_000_000)}M`;
  return `${Math.round(v / 1_000_000)}M`;
}

/**
 * Accumulates session token usage for the TUI footer.
 * - total (Σ): sum of billed tokens from every llm_done (main + spawn)
 * - ctx: last prompt_tokens from main-agent turns only (spawn_start/end gated)
 */
export class TokenStatusTracker {
  totalBilled = 0;
  lastContext: number | undefined;
  private activeSpawns = 0;
  private sessionKey = '';

  /** Reset counters when the active session id changes. */
  bindSession(sessionKey: string): void {
    const key = sessionKey.trim();
    if (key === this.sessionKey) return;
    this.sessionKey = key;
    this.reset();
  }

  reset(): void {
    this.totalBilled = 0;
    this.lastContext = undefined;
    this.activeSpawns = 0;
  }

  onSpawnStart(): void {
    this.activeSpawns += 1;
  }

  onSpawnEnd(): void {
    this.activeSpawns = Math.max(0, this.activeSpawns - 1);
  }

  onLlmDone(usage: unknown): boolean {
    const parsed = readUsageTokens(usage);
    let changed = false;
    if (parsed.billed !== undefined && parsed.billed > 0) {
      this.totalBilled += parsed.billed;
      changed = true;
    }
    // Only main-agent prompt size is "agent context" occupancy.
    if (parsed.prompt !== undefined && this.activeSpawns === 0) {
      if (this.lastContext !== parsed.prompt) {
        this.lastContext = parsed.prompt;
        changed = true;
      }
    }
    return changed;
  }

  /**
   * Status fragment, e.g. `Σ:12.3k · ctx:8.1k/1.0M`.
   * Empty when no usage has been observed yet.
   */
  formatStatus(contextLimit?: number): string {
    if (this.totalBilled <= 0 && this.lastContext === undefined) return '';
    const parts: string[] = [];
    if (this.totalBilled > 0) {
      parts.push(`Σ:${formatCompactTokens(this.totalBilled)}`);
    }
    if (this.lastContext !== undefined) {
      let ctx = `ctx:${formatCompactTokens(this.lastContext)}`;
      if (contextLimit !== undefined && contextLimit > 0) {
        ctx += `/${formatCompactTokens(contextLimit)}`;
      }
      parts.push(ctx);
    }
    return parts.join(' · ');
  }
}
