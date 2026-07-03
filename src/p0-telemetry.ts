import { existsSync, readFileSync } from 'node:fs';
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';

import type { RuntimeEvent } from './events.js';

const SCHEMA_VERSION = 1;

export interface P0TurnRecord {
  turn: number;
  wall_ms: number;
  actions_saved?: number;
  action_save_ms?: number;
  queue_depth?: number;
  tool_calls?: number;
}

export interface P0SpawnRecord {
  preset: string;
  wall_ms: number;
  ok: boolean;
  detail?: string;
}

export interface P0RunRecord {
  v: typeof SCHEMA_VERSION;
  run_id: string;
  recorded_at: string;
  session_id: string;
  cwd: string;
  reason: 'completed' | 'aborted' | 'error';
  message?: string;
  duration_ms: number;
  rss_start_mb: number;
  rss_end_mb: number;
  turn_count: number;
  turns: P0TurnRecord[];
  turn_wall_p50_ms: number | null;
  turn_wall_p95_ms: number | null;
  actions_saved_total: number;
  action_save_ms_total: number;
  action_flush_ms_total: number;
  action_flush_count: number;
  index_flush_ms_total: number;
  index_flush_count: number;
  spawn_count: number;
  spawns: P0SpawnRecord[];
}

export function isP0TelemetryEnabled(): boolean {
  const raw = process.env.P0_TELEMETRY?.trim().toLowerCase();
  if (raw === '1' || raw === 'true' || raw === 'yes') return true;
  if (raw === 'auto') {
    return process.env.ACTION_IO_METRICS === '1';
  }
  return false;
}

export function p0TelemetryDir(cwd: string): string {
  return resolve(cwd, 'workspace', 'p0-telemetry');
}

export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return Math.round(sorted[Math.max(0, idx)]! * 100) / 100;
}

function rssMb(): number {
  return Math.round((process.memoryUsage().rss / (1024 * 1024)) * 100) / 100;
}

function newRunId(): string {
  return `run_${Date.now().toString(36)}_${randomBytes(3).toString('hex')}`;
}

export class P0TelemetryCollector {
  private runStartedAt = 0;
  private sessionId = '';
  private readonly cwd: string;
  private rssStartMb = 0;
  private readonly turnStarts = new Map<number, number>();
  private readonly turns = new Map<number, P0TurnRecord>();
  private readonly spawns: P0SpawnRecord[] = [];
  private readonly activeSpawnStack: Array<{ preset: string; startedAt: number }> = [];
  private actionFlushMsTotal = 0;
  private actionFlushCount = 0;
  private indexFlushMsTotal = 0;
  private indexFlushCount = 0;
  private closed = false;

  constructor(cwd: string) {
    this.cwd = cwd;
  }

  onEvent(event: RuntimeEvent): void {
    if (this.closed) return;

    switch (event.type) {
      case 'run_start':
        this.runStartedAt = performance.now();
        this.sessionId = event.session_id;
        this.rssStartMb = rssMb();
        break;

      case 'turn_start': {
        const now = performance.now();
        this.closeOpenTurnsBefore(event.turn, now);
        this.turnStarts.set(event.turn, now);
        if (!this.turns.has(event.turn)) {
          this.turns.set(event.turn, { turn: event.turn, wall_ms: 0 });
        }
        break;
      }

      case 'tool_plan': {
        const row = this.ensureTurn(event.turn);
        row.tool_calls = event.total;
        break;
      }

      case 'turn_io': {
        const row = this.ensureTurn(event.turn);
        row.actions_saved = event.actions_saved;
        row.action_save_ms = event.action_save_ms;
        row.queue_depth = event.queue_depth;
        break;
      }

      case 'final':
        this.closeTurn(event.turn, performance.now());
        break;

      case 'spawn_start':
        this.activeSpawnStack.push({
          preset: event.preset,
          startedAt: performance.now(),
        });
        break;

      case 'spawn_end': {
        const idx = [...this.activeSpawnStack]
          .map((entry, i) => ({ entry, i }))
          .reverse()
          .find(({ entry }) => entry.preset === event.preset)?.i;
        const active =
          idx !== undefined
            ? this.activeSpawnStack.splice(idx, 1)[0]
            : this.activeSpawnStack.pop();
        const startedAt = active?.startedAt ?? performance.now();
        this.spawns.push({
          preset: event.preset,
          wall_ms: Math.round((performance.now() - startedAt) * 100) / 100,
          ok: event.ok,
          detail: event.detail,
        });
        break;
      }

      case 'action_flush':
        this.actionFlushMsTotal += event.flush_ms;
        this.actionFlushCount += event.count;
        break;

      case 'index_flush':
        this.indexFlushMsTotal += event.flush_ms;
        this.indexFlushCount += event.count;
        break;

      case 'run_end':
        this.closeOpenTurnsBefore(Number.MAX_SAFE_INTEGER, performance.now());
        void this.persist({
          reason: event.reason,
          message: event.message,
        });
        this.closed = true;
        break;
    }
  }

  private ensureTurn(turn: number): P0TurnRecord {
    let row = this.turns.get(turn);
    if (!row) {
      row = { turn, wall_ms: 0 };
      this.turns.set(turn, row);
    }
    return row;
  }

  private closeTurn(turn: number, endMs: number): void {
    const started = this.turnStarts.get(turn);
    if (started === undefined) return;
    const row = this.ensureTurn(turn);
    row.wall_ms = Math.round((endMs - started) * 100) / 100;
    this.turnStarts.delete(turn);
  }

  private closeOpenTurnsBefore(nextTurn: number, now: number): void {
    for (const [turn, startedAt] of this.turnStarts) {
      if (turn >= nextTurn) continue;
      const row = this.ensureTurn(turn);
      if (row.wall_ms <= 0) {
        row.wall_ms = Math.round((now - startedAt) * 100) / 100;
      }
      this.turnStarts.delete(turn);
    }
  }

  private async persist(opts: {
    reason: P0RunRecord['reason'];
    message?: string;
  }): Promise<void> {
    const turnList = [...this.turns.values()].sort((a, b) => a.turn - b.turn);
    const wallMs = turnList.map((t) => t.wall_ms).filter((n) => n > 0);

    let actionsSavedTotal = 0;
    let actionSaveMsTotal = 0;
    for (const turn of turnList) {
      actionsSavedTotal += turn.actions_saved ?? 0;
      actionSaveMsTotal += turn.action_save_ms ?? 0;
    }

    const endedAt = performance.now();
    const record: P0RunRecord = {
      v: SCHEMA_VERSION,
      run_id: newRunId(),
      recorded_at: new Date().toISOString(),
      session_id: this.sessionId,
      cwd: this.cwd,
      reason: opts.reason,
      message: opts.message,
      duration_ms: Math.round((endedAt - this.runStartedAt) * 100) / 100,
      rss_start_mb: this.rssStartMb,
      rss_end_mb: rssMb(),
      turn_count: turnList.length,
      turns: turnList,
      turn_wall_p50_ms: percentile(wallMs, 50),
      turn_wall_p95_ms: percentile(wallMs, 95),
      actions_saved_total: actionsSavedTotal,
      action_save_ms_total: Math.round(actionSaveMsTotal * 100) / 100,
      action_flush_ms_total: Math.round(this.actionFlushMsTotal * 100) / 100,
      action_flush_count: this.actionFlushCount,
      index_flush_ms_total: Math.round(this.indexFlushMsTotal * 100) / 100,
      index_flush_count: this.indexFlushCount,
      spawn_count: this.spawns.length,
      spawns: this.spawns,
    };

    await writeRunRecord(this.cwd, record);
  }
}

export function createP0Collector(cwd: string): P0TelemetryCollector {
  return new P0TelemetryCollector(cwd);
}

export interface P0CompareMetric {
  key: string;
  label: string;
  baseline: number | null;
  candidate: number | null;
  delta_abs: number | null;
  delta_pct: number | null;
}

export interface P0CompareResult {
  baseline_id: string;
  candidate_id: string;
  metrics: P0CompareMetric[];
}

const P0_COMPARE_METRICS: Array<{
  key: string;
  label: string;
  pick: (r: P0RunRecord) => number | null;
}> = [
  { key: 'duration_ms', label: 'duration_ms', pick: (r) => r.duration_ms },
  { key: 'turn_count', label: 'turns', pick: (r) => r.turn_count },
  { key: 'turn_wall_p50_ms', label: 'turn_p50_ms', pick: (r) => r.turn_wall_p50_ms },
  { key: 'turn_wall_p95_ms', label: 'turn_p95_ms', pick: (r) => r.turn_wall_p95_ms },
  { key: 'actions_saved_total', label: 'actions_saved', pick: (r) => r.actions_saved_total },
  { key: 'action_save_ms_total', label: 'action_save_ms', pick: (r) => r.action_save_ms_total },
  {
    key: 'action_flush_ms_total',
    label: 'action_flush_ms',
    pick: (r) => r.action_flush_ms_total,
  },
  { key: 'action_flush_count', label: 'action_flush_n', pick: (r) => r.action_flush_count },
  { key: 'index_flush_ms_total', label: 'index_flush_ms', pick: (r) => r.index_flush_ms_total },
  { key: 'index_flush_count', label: 'index_flush_n', pick: (r) => r.index_flush_count },
  { key: 'spawn_count', label: 'spawns', pick: (r) => r.spawn_count },
  { key: 'rss_start_mb', label: 'rss_start_mb', pick: (r) => r.rss_start_mb },
  { key: 'rss_end_mb', label: 'rss_end_mb', pick: (r) => r.rss_end_mb },
];

function deltaPct(baseline: number, candidate: number): number | null {
  if (baseline === 0) return null;
  return Math.round(((candidate - baseline) / baseline) * 10000) / 100;
}

export function loadP0Runs(cwd: string): P0RunRecord[] {
  const path = resolve(p0TelemetryDir(cwd), 'runs.jsonl');
  if (!existsSync(path)) return [];
  const content = readFileSync(path, 'utf8').trim();
  if (!content) return [];
  return content
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as P0RunRecord);
}

export function findP0Run(runs: P0RunRecord[], runId: string): P0RunRecord | undefined {
  return runs.find((r) => r.run_id === runId);
}

export function compareP0Runs(baseline: P0RunRecord, candidate: P0RunRecord): P0CompareResult {
  const metrics: P0CompareMetric[] = P0_COMPARE_METRICS.map(({ key, label, pick }) => {
    const base = pick(baseline);
    const cand = pick(candidate);
    if (base === null || cand === null) {
      return { key, label, baseline: base, candidate: cand, delta_abs: null, delta_pct: null };
    }
    const deltaAbs = Math.round((cand - base) * 100) / 100;
    return {
      key,
      label,
      baseline: base,
      candidate: cand,
      delta_abs: deltaAbs,
      delta_pct: deltaPct(base, cand),
    };
  });

  return {
    baseline_id: baseline.run_id,
    candidate_id: candidate.run_id,
    metrics,
  };
}

export async function writeRunRecord(cwd: string, record: P0RunRecord): Promise<void> {
  const dir = p0TelemetryDir(cwd);
  await mkdir(dir, { recursive: true });
  const line = `${JSON.stringify(record)}\n`;
  await appendFile(resolve(dir, 'runs.jsonl'), line, 'utf8');
  await writeFile(resolve(dir, 'latest.json'), `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  await appendSummaryRow(dir, record);
}

function formatSummaryRow(record: P0RunRecord): string {
  const cols = [
    record.recorded_at.slice(0, 19),
    record.session_id,
    record.reason,
    String(record.turn_count),
    record.turn_wall_p50_ms?.toString() ?? '',
    record.turn_wall_p95_ms?.toString() ?? '',
    String(record.actions_saved_total),
    record.action_save_ms_total.toString(),
    String(record.spawn_count),
    record.rss_end_mb.toString(),
    record.run_id,
  ];
  return `${cols.join('\t')}\n`;
}

async function appendSummaryRow(dir: string, record: P0RunRecord): Promise<void> {
  const path = resolve(dir, 'summary.tsv');
  const { access, readFile } = await import('node:fs/promises');
  let needsHeader = true;
  try {
    await access(path);
    const existing = await readFile(path, 'utf8');
    needsHeader = existing.trim().length === 0;
  } catch {
    needsHeader = true;
  }

  const header =
    'recorded_at\tsession_id\treason\tturns\tturn_p50_ms\tturn_p95_ms\tactions_saved\taction_save_ms\tspawns\trss_end_mb\trun_id\n';
  const row = formatSummaryRow(record);
  if (needsHeader) {
    await writeFile(path, header + row, 'utf8');
  } else {
    await appendFile(path, row, 'utf8');
  }
}