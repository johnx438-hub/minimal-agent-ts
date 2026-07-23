import type { RuntimeEvent } from '../events.js';
import type { EvalTurnRecord } from './types.js';

/**
 * Collapse absolute/relative paths so the same file fingerprints alike.
 * Uses the last 1–2 path segments (e.g. `docs/03_distractor.md`) so long
 * `/home/.../eval/runs/.../docs/x` prefixes do not collide when truncated.
 */
export function normalizePathForFingerprint(pathLike: string): string {
  const n = pathLike.replace(/\\/g, '/').replace(/\/+/g, '/');
  const parts = n.split('/').filter((p) => p.length > 0 && p !== '.');
  if (parts.length === 0) return n || '.';
  if (parts.length === 1) return parts[0];
  // Drop Windows drive letter segment if present (e.g. C:)
  const cleaned =
    parts[0].length === 2 && parts[0].endsWith(':') ? parts.slice(1) : parts;
  if (cleaned.length <= 2) return cleaned.join('/');
  return cleaned.slice(-2).join('/');
}

function fingerprintField(key: string, value: string | number): string {
  if (typeof value === 'number') return `${key}=${value}`;
  const s = value;
  if (key === 'path' || key === 'file' || key === 'cwd') {
    return `${key}=${normalizePathForFingerprint(s)}`;
  }
  if (key === 'command' || key === 'url' || key === 'query' || key === 'pattern') {
    // Keep head+tail so long commands stay distinguishable without prefix-only collision.
    if (s.length <= 96) return `${key}=${s}`;
    return `${key}=${s.slice(0, 48)}…${s.slice(-32)}`;
  }
  return `${key}=${s.slice(0, 80)}`;
}

/** Stable fingerprint for repeat-tool detection (name + coarse args). */
export function toolArgsFingerprint(name: string, args: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(args);
  } catch {
    return `${name}:${args.slice(0, 120)}`;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return `${name}:${args.slice(0, 120)}`;
  }
  const o = parsed as Record<string, unknown>;
  const keys = ['path', 'file', 'command', 'pattern', 'query', 'cwd', 'url'];
  const parts: string[] = [name];
  for (const k of keys) {
    if (typeof o[k] === 'string' || typeof o[k] === 'number') {
      parts.push(fingerprintField(k, o[k] as string | number));
    }
  }
  if (parts.length === 1) {
    parts.push(args.slice(0, 80));
  }
  return parts.join('|');
}

function asFiniteNonNeg(v: unknown): number | undefined {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return undefined;
  return Math.floor(v);
}

/**
 * Aggregates RuntimeEvents into per-turn records for turns.jsonl.
 */
export class EvalTelemetryCollector {
  private turns = new Map<number, EvalTurnRecord>();
  private turnStartedAt = new Map<number, number>();
  private rawCount = 0;

  get eventCount(): number {
    return this.rawCount;
  }

  onEvent(event: RuntimeEvent, ts: number = Date.now()): void {
    this.rawCount += 1;
    if (!('turn' in event) || typeof (event as { turn?: unknown }).turn !== 'number') {
      return;
    }
    const turn = (event as { turn: number }).turn;
    const rec = this.ensure(turn);

    switch (event.type) {
      case 'turn_start':
        this.turnStartedAt.set(turn, ts);
        break;
      case 'llm_done': {
        const u = event.usage ?? {};
        rec.prompt_tokens = asFiniteNonNeg(u.prompt_tokens) ?? rec.prompt_tokens;
        rec.completion_tokens =
          asFiniteNonNeg(u.completion_tokens) ?? rec.completion_tokens;
        rec.total_tokens = asFiniteNonNeg(u.total_tokens) ?? rec.total_tokens;
        if (event.cache?.cached_tokens !== undefined) {
          rec.cache_cached_tokens = event.cache.cached_tokens;
        }
        const started = this.turnStartedAt.get(turn);
        if (started !== undefined) {
          rec.wall_ms = Math.max(0, ts - started);
        }
        break;
      }
      case 'tool_call':
        rec.tool_calls.push({
          name: event.name,
          args_fp: toolArgsFingerprint(event.name, event.args),
          call_id: event.call_id,
        });
        break;
      case 'compression':
        rec.pointerized = (rec.pointerized ?? 0) + event.pointerized;
        rec.pruned = (rec.pruned ?? 0) + event.pruned;
        rec.pointer_compacted =
          (rec.pointer_compacted ?? 0) + event.pointer_compacted;
        if (event.heavy_compression) rec.heavy_compression = true;
        break;
      case 'loop_guard':
        rec.loop_guard_actions.push(event.action);
        break;
      default:
        break;
    }
  }

  private ensure(turn: number): EvalTurnRecord {
    let rec = this.turns.get(turn);
    if (!rec) {
      rec = { turn, tool_calls: [], loop_guard_actions: [] };
      this.turns.set(turn, rec);
    }
    return rec;
  }

  toRecords(): EvalTurnRecord[] {
    return [...this.turns.values()].sort((a, b) => a.turn - b.turn);
  }
}

export function computeRepeatToolRate(records: EvalTurnRecord[]): {
  rate: number;
  total: number;
  unique: number;
} {
  const fps: string[] = [];
  for (const r of records) {
    for (const t of r.tool_calls) {
      fps.push(t.args_fp);
    }
  }
  const total = fps.length;
  if (total === 0) return { rate: 0, total: 0, unique: 0 };
  const unique = new Set(fps).size;
  const repeats = total - unique;
  return { rate: repeats / total, total, unique };
}

export function computeHotTokenStats(records: EvalTurnRecord[]): {
  mean: number | null;
  p95: number | null;
  sum: number;
} {
  const vals = records
    .map((r) => r.prompt_tokens)
    .filter((v): v is number => typeof v === 'number' && v > 0)
    .sort((a, b) => a - b);
  if (vals.length === 0) return { mean: null, p95: null, sum: 0 };
  const sum = vals.reduce((a, b) => a + b, 0);
  const mean = sum / vals.length;
  const idx = Math.min(vals.length - 1, Math.floor(vals.length * 0.95));
  return { mean, p95: vals[idx], sum };
}
