import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  compareP0Runs,
  loadP0Runs,
  P0TelemetryCollector,
  percentile,
  p0TelemetryDir,
  writeRunRecord,
  type P0RunRecord,
} from '../src/p0-telemetry.js';

describe('p0 telemetry', () => {
  it('computes percentiles', () => {
    assert.equal(percentile([], 50), null);
    assert.equal(percentile([10, 20, 30, 40], 50), 20);
    assert.equal(percentile([10, 20, 30, 40], 95), 40);
  });

  it('records turn and spawn metrics on run_end', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ma-p0-'));
    const collector = new P0TelemetryCollector(dir);

    collector.onEvent({ type: 'run_start', session_id: 'session_p0', cwd: dir });
    collector.onEvent({ type: 'turn_start', turn: 1 });
    collector.onEvent({
      type: 'tool_plan',
      turn: 1,
      total: 2,
      parallel_count: 2,
      serial_count: 0,
      entries: [],
    });
    collector.onEvent({
      type: 'turn_io',
      turn: 1,
      actions_saved: 2,
      action_save_ms: 0.4,
      queue_depth: 1,
    });
    collector.onEvent({ type: 'spawn_start', preset: 'web-researcher' });
    collector.onEvent({
      type: 'spawn_end',
      preset: 'web-researcher',
      ok: true,
    });
    collector.onEvent({ type: 'action_flush', flush_ms: 1.2, count: 2, pending: 0 });
    collector.onEvent({ type: 'run_end', reason: 'completed' });

    await new Promise((resolve) => setTimeout(resolve, 30));

    const outDir = p0TelemetryDir(dir);
    assert.ok(existsSync(join(outDir, 'runs.jsonl')));
    assert.ok(existsSync(join(outDir, 'latest.json')));
    assert.ok(existsSync(join(outDir, 'summary.tsv')));

    const latest = JSON.parse(readFileSync(join(outDir, 'latest.json'), 'utf8')) as P0RunRecord;
    assert.equal(latest.session_id, 'session_p0');
    assert.equal(latest.turn_count, 1);
    assert.equal(latest.actions_saved_total, 2);
    assert.equal(latest.spawn_count, 1);
    assert.ok((latest.turn_wall_p50_ms ?? 0) >= 0);
  });

  it('writes summary header once', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ma-p0-summary-'));
    const base: P0RunRecord = {
      v: 1,
      run_id: 'run_test',
      recorded_at: '2026-07-04T12:00:00.000Z',
      session_id: 'session_a',
      cwd: dir,
      reason: 'completed',
      duration_ms: 10,
      rss_start_mb: 100,
      rss_end_mb: 110,
      turn_count: 1,
      turns: [{ turn: 1, wall_ms: 5 }],
      turn_wall_p50_ms: 5,
      turn_wall_p95_ms: 5,
      actions_saved_total: 0,
      action_save_ms_total: 0,
      action_flush_ms_total: 0,
      action_flush_count: 0,
      spawn_count: 0,
      spawns: [],
    };

    await writeRunRecord(dir, base);
    await writeRunRecord(dir, { ...base, run_id: 'run_test_2', session_id: 'session_b' });

    const summary = readFileSync(join(p0TelemetryDir(dir), 'summary.tsv'), 'utf8');
    assert.equal(summary.split('\n').filter(Boolean).length, 3);
    assert.match(summary, /^recorded_at\t/);
  });

  it('loads runs and compares baseline vs candidate', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ma-p0-compare-'));
    const makeRun = (overrides: Partial<P0RunRecord>): P0RunRecord => ({
      v: 1,
      run_id: 'run_base',
      recorded_at: '2026-07-04T12:00:00.000Z',
      session_id: 'session_a',
      cwd: dir,
      reason: 'completed',
      duration_ms: 1000,
      rss_start_mb: 100,
      rss_end_mb: 120,
      turn_count: 2,
      turns: [
        { turn: 1, wall_ms: 100 },
        { turn: 2, wall_ms: 200 },
      ],
      turn_wall_p50_ms: 150,
      turn_wall_p95_ms: 200,
      actions_saved_total: 4,
      action_save_ms_total: 2,
      action_flush_ms_total: 1,
      action_flush_count: 1,
      spawn_count: 0,
      spawns: [],
      ...overrides,
    });

    await writeRunRecord(dir, makeRun({ run_id: 'run_base' }));
    await writeRunRecord(
      dir,
      makeRun({
        run_id: 'run_candidate',
        duration_ms: 800,
        turn_wall_p50_ms: 120,
        turn_wall_p95_ms: 160,
        actions_saved_total: 6,
        rss_end_mb: 110,
      }),
    );

    const runs = loadP0Runs(dir);
    assert.equal(runs.length, 2);

    const result = compareP0Runs(runs[0]!, runs[1]!);
    assert.equal(result.baseline_id, 'run_base');
    assert.equal(result.candidate_id, 'run_candidate');

    const p50 = result.metrics.find((m) => m.key === 'turn_wall_p50_ms');
    assert.equal(p50?.baseline, 150);
    assert.equal(p50?.candidate, 120);
    assert.equal(p50?.delta_abs, -30);
    assert.equal(p50?.delta_pct, -20);

    const duration = result.metrics.find((m) => m.key === 'duration_ms');
    assert.equal(duration?.delta_pct, -20);
  });
});