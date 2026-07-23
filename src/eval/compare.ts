import { join } from 'node:path';

import {
  aggregateRuns,
  writeAggregateReport,
  type AggregateReport,
} from './aggregate.js';
import { resolveEvalRoot } from './load.js';
import { runEval, type EvalRunResult } from './run.js';

export interface CompareOptions {
  projectRoot: string;
  evalRoot?: string;
  taskId: string;
  strategyIds: string[];
  /** Repeats per strategy (default 1). */
  n?: number;
  maxTurns?: number;
  timeoutSec?: number;
  allowShell?: boolean;
  allowWeb?: boolean;
  dryRun?: boolean;
  plantCorrectAnswer?: boolean;
  /** Write under eval/reports/ (default). */
  reportBasename?: string;
  includeDryRunInReport?: boolean;
}

export interface CompareResult {
  results: EvalRunResult[];
  report: AggregateReport;
  jsonPath: string;
  mdPath: string;
}

/**
 * Run task × each strategy (× n), then aggregate those runs into a report.
 */
export async function compareStrategies(opts: CompareOptions): Promise<CompareResult> {
  const n = Math.max(1, opts.n ?? 1);
  const results: EvalRunResult[] = [];
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');

  for (const strategyId of opts.strategyIds) {
    for (let i = 0; i < n; i++) {
      const runId = `cmp_${opts.taskId}__${strategyId}__${stamp}__${i + 1}`;
      const r = await runEval({
        projectRoot: opts.projectRoot,
        evalRoot: opts.evalRoot,
        taskId: opts.taskId,
        strategyId,
        maxTurns: opts.maxTurns,
        timeoutSec: opts.timeoutSec,
        allowShell: opts.allowShell,
        allowWeb: opts.allowWeb,
        dryRun: opts.dryRun,
        plantCorrectAnswer: opts.plantCorrectAnswer,
        runId,
      });
      results.push(r);
    }
  }

  const evalRoot = resolveEvalRoot(opts.projectRoot, opts.evalRoot);
  const runsDir = join(evalRoot, 'runs');
  const runIds = new Set(results.map((r) => r.manifest.run_id));

  // Aggregate only the runs we just produced (filter by run_id via post-filter)
  const full = aggregateRuns({
    runsDir,
    taskId: opts.taskId,
    strategyIds: opts.strategyIds,
    includeDryRun: opts.includeDryRunInReport ?? opts.dryRun !== false,
  });
  const report: AggregateReport = {
    ...full,
    runs: full.runs.filter((r) => runIds.has(r.run_id)),
    run_count: results.length,
    rows: full.rows
      .map((row) => {
        const subset = results.filter(
          (r) =>
            r.summary.task_id === row.task_id &&
            r.summary.strategy_id === row.strategy_id,
        );
        if (subset.length === 0) return null;
        // Recompute row only from this compare batch
        const success_n = subset.filter((r) => r.summary.task_success).length;
        const mean = (xs: number[]) =>
          xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
        const hot = subset
          .map((r) => r.summary.hot_tokens_mean)
          .filter((v): v is number => typeof v === 'number');
        return {
          task_id: row.task_id,
          strategy_id: row.strategy_id,
          n: subset.length,
          success_n,
          success_rate: success_n / subset.length,
          turns_mean: mean(subset.map((r) => r.summary.turns_used)),
          hot_tokens_mean: mean(hot),
          hot_tokens_p95_mean: mean(
            subset
              .map((r) => r.summary.hot_tokens_p95)
              .filter((v): v is number => typeof v === 'number'),
          ),
          repeat_tool_rate_mean: mean(subset.map((r) => r.summary.repeat_tool_rate)),
          tool_calls_mean: mean(subset.map((r) => r.summary.tool_calls_total)),
          prompt_tokens_total_mean: mean(
            subset.map((r) => r.summary.prompt_tokens_total),
          ),
          dry_run_n: subset.filter((r) => r.manifest.dry_run).length,
          run_ids: subset.map((r) => r.manifest.run_id),
        };
      })
      .filter((r): r is NonNullable<typeof r> => r !== null),
  };

  // Fix rounding on recomputed rows
  for (const row of report.rows) {
    row.success_rate = Math.round(row.success_rate * 10000) / 10000;
    if (row.turns_mean !== null) row.turns_mean = Math.round(row.turns_mean * 100) / 100;
    if (row.hot_tokens_mean !== null) {
      row.hot_tokens_mean = Math.round(row.hot_tokens_mean * 10) / 10;
    }
    if (row.repeat_tool_rate_mean !== null) {
      row.repeat_tool_rate_mean =
        Math.round(row.repeat_tool_rate_mean * 10000) / 10000;
    }
  }

  const basename =
    opts.reportBasename ??
    `compare_${opts.taskId}_${opts.strategyIds.join('-')}_${stamp.slice(0, 19)}`;
  const reportsDir = join(evalRoot, 'reports');
  const { jsonPath, mdPath } = writeAggregateReport(report, reportsDir, basename);

  return { results, report, jsonPath, mdPath };
}
