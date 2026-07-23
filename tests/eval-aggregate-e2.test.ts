import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  aggregateRuns,
  formatAggregateMarkdown,
  loadEvalRuns,
  writeAggregateReport,
} from '../src/eval/aggregate.js';
import { compareStrategies } from '../src/eval/compare.js';
import { defaultProjectRoot, runEval } from '../src/eval/run.js';

const ROOT = defaultProjectRoot();
const RUNS = join(ROOT, 'eval/runs');
const REPORTS = join(ROOT, 'eval/reports');

describe('eval aggregate E2', () => {
  it('loads existing runs and groups by strategy', async () => {
    // Ensure at least two strategy runs exist
    await runEval({
      projectRoot: ROOT,
      taskId: 'state_chain_01',
      strategyId: 'minimal_full',
      dryRun: true,
      plantCorrectAnswer: true,
      runId: `e2_agg_full_${Date.now()}`,
    });
    await runEval({
      projectRoot: ROOT,
      taskId: 'state_chain_01',
      strategyId: 'minimal_no_pointerize',
      dryRun: true,
      plantCorrectAnswer: true,
      runId: `e2_agg_nopointer_${Date.now()}`,
    });

    const loaded = loadEvalRuns(RUNS);
    assert.ok(loaded.length >= 2);

    const report = aggregateRuns({
      runsDir: RUNS,
      taskId: 'state_chain_01',
      strategyIds: ['minimal_full', 'minimal_no_pointerize'],
      includeDryRun: true,
    });
    assert.ok(report.rows.length >= 1);
    const ids = new Set(report.rows.map((r) => r.strategy_id));
    assert.ok(ids.has('minimal_full') || ids.has('minimal_no_pointerize'));

    for (const row of report.rows) {
      assert.ok(row.n >= 1);
      assert.ok(row.success_rate >= 0 && row.success_rate <= 1);
    }

    const md = formatAggregateMarkdown(report);
    assert.match(md, /Eval aggregate report/);
    assert.match(md, /success_rate/);

    const { mdPath, jsonPath } = writeAggregateReport(
      report,
      REPORTS,
      `test_aggregate_${Date.now()}`,
    );
    assert.ok(existsSync(mdPath));
    assert.ok(existsSync(jsonPath));
    const slim = JSON.parse(readFileSync(jsonPath, 'utf8'));
    assert.ok(Array.isArray(slim.rows));
  });

  it('compareStrategies runs two dry strategies and writes report', async () => {
    const stamp = Date.now();
    const result = await compareStrategies({
      projectRoot: ROOT,
      taskId: 'state_chain_01',
      strategyIds: ['minimal_full', 'minimal_no_pointerize'],
      dryRun: true,
      plantCorrectAnswer: true,
      n: 1,
      reportBasename: `test_compare_${stamp}`,
    });
    assert.equal(result.results.length, 2);
    assert.equal(result.report.rows.length, 2);
    assert.ok(existsSync(result.mdPath));
    assert.ok(existsSync(result.jsonPath));
    assert.ok(result.results.every((r) => r.summary.task_success));

    const md = readFileSync(result.mdPath, 'utf8');
    assert.match(md, /minimal_full/);
    assert.match(md, /minimal_no_pointerize/);
  });
});
