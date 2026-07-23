import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import type { EvalManifest, EvalSummary } from './types.js';

export interface LoadedEvalRun {
  run_dir: string;
  run_id: string;
  summary: EvalSummary;
  manifest: EvalManifest | null;
  dry_run: boolean;
}

export interface StrategyAggregateRow {
  task_id: string;
  strategy_id: string;
  n: number;
  success_n: number;
  success_rate: number;
  turns_mean: number | null;
  hot_tokens_mean: number | null;
  hot_tokens_p95_mean: number | null;
  repeat_tool_rate_mean: number | null;
  tool_calls_mean: number | null;
  prompt_tokens_total_mean: number | null;
  dry_run_n: number;
  cost_usd_est_mean: number | null;
  run_ids: string[];
}

export interface AggregateReport {
  generated_at: string;
  runs_dir: string;
  filters: {
    task_id?: string;
    strategy_ids?: string[];
    include_dry_run: boolean;
  };
  run_count: number;
  rows: StrategyAggregateRow[];
  runs: LoadedEvalRun[];
}

function readJsonSafe<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return null;
  }
}

function mean(nums: number[]): number | null {
  if (nums.length === 0) return null;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

function round(n: number | null, digits = 4): number | null {
  if (n === null || !Number.isFinite(n)) return null;
  const p = 10 ** digits;
  return Math.round(n * p) / p;
}

/** Load all run folders that contain summary.json under runsDir. */
export function loadEvalRuns(runsDir: string): LoadedEvalRun[] {
  if (!existsSync(runsDir)) return [];
  const out: LoadedEvalRun[] = [];
  for (const name of readdirSync(runsDir)) {
    const runDir = join(runsDir, name);
    try {
      if (!statSync(runDir).isDirectory()) continue;
    } catch {
      continue;
    }
    const summaryPath = join(runDir, 'summary.json');
    if (!existsSync(summaryPath)) continue;
    const summary = readJsonSafe<EvalSummary>(summaryPath);
    if (!summary?.run_id || !summary.task_id || !summary.strategy_id) continue;
    const manifest = readJsonSafe<EvalManifest>(join(runDir, 'manifest.json'));
    out.push({
      run_dir: runDir,
      run_id: summary.run_id,
      summary,
      manifest,
      dry_run: Boolean(manifest?.dry_run),
    });
  }
  // Newest first by directory mtime when possible
  out.sort((a, b) => {
    try {
      return statSync(b.run_dir).mtimeMs - statSync(a.run_dir).mtimeMs;
    } catch {
      return a.run_id < b.run_id ? 1 : -1;
    }
  });
  return out;
}

export interface AggregateOptions {
  runsDir: string;
  taskId?: string;
  strategyIds?: string[];
  /** Default true for offline tables; set false to only live API runs. */
  includeDryRun?: boolean;
}

export function aggregateRuns(opts: AggregateOptions): AggregateReport {
  const includeDryRun = opts.includeDryRun !== false;
  let runs = loadEvalRuns(opts.runsDir);
  if (opts.taskId) {
    runs = runs.filter((r) => r.summary.task_id === opts.taskId);
  }
  if (opts.strategyIds?.length) {
    const set = new Set(opts.strategyIds);
    runs = runs.filter((r) => set.has(r.summary.strategy_id));
  }
  if (!includeDryRun) {
    runs = runs.filter((r) => !r.dry_run);
  }

  const groups = new Map<string, LoadedEvalRun[]>();
  for (const r of runs) {
    const key = `${r.summary.task_id}::${r.summary.strategy_id}`;
    const list = groups.get(key) ?? [];
    list.push(r);
    groups.set(key, list);
  }

  const rows: StrategyAggregateRow[] = [];
  for (const [, list] of groups) {
    const task_id = list[0].summary.task_id;
    const strategy_id = list[0].summary.strategy_id;
    const success_n = list.filter((r) => r.summary.task_success).length;
    const turns = list.map((r) => r.summary.turns_used);
    const hot = list
      .map((r) => r.summary.hot_tokens_mean)
      .filter((v): v is number => typeof v === 'number');
    const hotP95 = list
      .map((r) => r.summary.hot_tokens_p95)
      .filter((v): v is number => typeof v === 'number');
    const repeat = list.map((r) => r.summary.repeat_tool_rate);
    const tools = list.map((r) => r.summary.tool_calls_total);
    const prompt = list.map((r) => r.summary.prompt_tokens_total);
    const costs = list
      .map((r) => r.summary.cost_usd_est)
      .filter((v): v is number => typeof v === 'number');

    rows.push({
      task_id,
      strategy_id,
      n: list.length,
      success_n,
      success_rate: round(success_n / list.length, 4) ?? 0,
      turns_mean: round(mean(turns), 2),
      hot_tokens_mean: round(mean(hot), 1),
      hot_tokens_p95_mean: round(mean(hotP95), 1),
      repeat_tool_rate_mean: round(mean(repeat), 4),
      tool_calls_mean: round(mean(tools), 2),
      prompt_tokens_total_mean: round(mean(prompt), 1),
      dry_run_n: list.filter((r) => r.dry_run).length,
      cost_usd_est_mean: round(mean(costs), 6),
      run_ids: list.map((r) => r.run_id),
    });
  }

  rows.sort((a, b) => {
    if (a.task_id !== b.task_id) return a.task_id.localeCompare(b.task_id);
    return a.strategy_id.localeCompare(b.strategy_id);
  });

  return {
    generated_at: new Date().toISOString(),
    runs_dir: opts.runsDir,
    filters: {
      task_id: opts.taskId,
      strategy_ids: opts.strategyIds,
      include_dry_run: includeDryRun,
    },
    run_count: runs.length,
    rows,
    runs,
  };
}

function fmt(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  return String(n);
}

/** Markdown table for primary eval metrics (EVAL_LITM four-pack + n). */
export function formatAggregateMarkdown(report: AggregateReport): string {
  const lines: string[] = [
    `# Eval aggregate report`,
    ``,
    `- Generated: \`${report.generated_at}\``,
    `- Runs dir: \`${report.runs_dir}\``,
    `- Runs included: **${report.run_count}**`,
  ];
  if (report.filters.task_id) {
    lines.push(`- Task filter: \`${report.filters.task_id}\``);
  }
  if (report.filters.strategy_ids?.length) {
    lines.push(`- Strategies: ${report.filters.strategy_ids.map((s) => `\`${s}\``).join(', ')}`);
  }
  lines.push(
    `- Include dry-run: **${report.filters.include_dry_run}**`,
    ``,
    `## By strategy`,
    ``,
    `| task | strategy | n | success | success_rate | turns̄ | hot_tokens̄ | repeat_tool̄ | tools̄ | $̄ | dry_n |`,
    `|------|----------|---|--------:|-------------:|-------:|------------:|------------:|------:|---:|------:|`,
  );

  for (const r of report.rows) {
    lines.push(
      `| ${r.task_id} | ${r.strategy_id} | ${r.n} | ${r.success_n}/${r.n} | ${fmt(r.success_rate)} | ${fmt(r.turns_mean)} | ${fmt(r.hot_tokens_mean)} | ${fmt(r.repeat_tool_rate_mean)} | ${fmt(r.tool_calls_mean)} | ${fmt(r.cost_usd_est_mean)} | ${r.dry_run_n} |`,
    );
  }

  if (report.rows.length === 0) {
    lines.push(``, `_No runs matched filters._`);
  }

  lines.push(
    ``,
    `## Notes`,
    ``,
    `- Primary narrative metrics (EVAL_LITM): task_success, repeat_tool_rate, hot_tokens, cost/tokens (cost TBD).`,
    `- Dry-run rows have no LLM telemetry (\`hot_tokens\` / \`turns\` often empty).`,
    `- Optional \`$̄\` from \`EVAL_PRICE_PROMPT_PER_1M\` / \`EVAL_PRICE_COMPLETION_PER_1M\` (USD per 1M tokens).`,
    `- Live API variance is expected; report \`n\` and do not treat n=1 as a distribution.`,
    ``,
  );

  return lines.join('\n');
}

export function writeAggregateReport(
  report: AggregateReport,
  outDir: string,
  basename = 'aggregate',
): { jsonPath: string; mdPath: string } {
  mkdirSync(outDir, { recursive: true });
  const jsonPath = join(outDir, `${basename}.json`);
  const mdPath = join(outDir, `${basename}.md`);
  // Omit full runs list from JSON for size; keep rows + filters
  const slim = {
    generated_at: report.generated_at,
    runs_dir: report.runs_dir,
    filters: report.filters,
    run_count: report.run_count,
    rows: report.rows,
  };
  writeFileSync(jsonPath, `${JSON.stringify(slim, null, 2)}\n`, 'utf8');
  writeFileSync(mdPath, formatAggregateMarkdown(report), 'utf8');
  return { jsonPath, mdPath };
}
