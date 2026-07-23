#!/usr/bin/env node
/**
 * Eval CLI (E1–E2)
 *
 *   npm run eval:run -- --task state_chain_01 --strategy minimal_full --dry-run --plant
 *   npm run eval:aggregate -- --task state_chain_01
 *   npm run eval:compare -- --task state_chain_01 --strategies minimal_full,minimal_no_pointerize --dry-run --plant
 */

import { join, resolve } from 'node:path';

import { aggregateRuns, writeAggregateReport } from './aggregate.js';
import { compareStrategies } from './compare.js';
import { resolveEvalRoot } from './load.js';
import { defaultProjectRoot, runEval } from './run.js';

function usage(): never {
  console.error(`Usage:
  eval run --task <id> --strategy <id> [run options]
  eval aggregate [--task <id>] [--strategies a,b] [--out-name name] [--no-dry-run]
  eval compare --task <id> --strategies a,b [,c] [run options] [--n <repeats>]

Run options:
  --max-turns <n>       Override meta.max_turns
  --timeout-sec <n>     Abort after N seconds
  --allow-shell         Enable shell tools
  --allow-web           Enable web tools
  --dry-run             No LLM
  --plant               With --dry-run, plant correct answer
  --project-root <dir>  Repo root (default: auto)
  --run-id <id>         Force run folder name (run only)

Aggregate options:
  --task <id>           Filter task
  --strategies a,b      Filter strategies
  --out-name <base>     Write eval/reports/<base>.{md,json}
  --no-dry-run          Exclude dry-run runs
  --runs-dir <dir>      Override runs directory

Compare options:
  --strategies a,b      Required list to run and compare
  --n <k>               Repeats per strategy (default 1)
  --out-name <base>     Report basename under eval/reports/
`);
  process.exit(2);
}

type Parsed = {
  cmd: string;
  task?: string;
  strategy?: string;
  strategies?: string[];
  maxTurns?: number;
  timeoutSec?: number;
  allowShell: boolean;
  allowWeb: boolean;
  dryRun: boolean;
  plant: boolean;
  projectRoot?: string;
  runId?: string;
  n?: number;
  outName?: string;
  includeDryRun: boolean;
  runsDir?: string;
};

function parseArgs(argv: string[]): Parsed {
  const cmd = argv[0] ?? '';
  const out: Parsed = {
    cmd,
    allowShell: false,
    allowWeb: false,
    dryRun: false,
    plant: false,
    includeDryRun: true,
  };

  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) usage();
      return v;
    };
    switch (a) {
      case '--task':
        out.task = next();
        break;
      case '--strategy':
        out.strategy = next();
        break;
      case '--strategies':
        out.strategies = next()
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
        break;
      case '--max-turns':
        out.maxTurns = Number(next());
        break;
      case '--timeout-sec':
        out.timeoutSec = Number(next());
        break;
      case '--allow-shell':
        out.allowShell = true;
        break;
      case '--allow-web':
        out.allowWeb = true;
        break;
      case '--dry-run':
        out.dryRun = true;
        break;
      case '--plant':
        out.plant = true;
        break;
      case '--project-root':
        out.projectRoot = resolve(next());
        break;
      case '--run-id':
        out.runId = next();
        break;
      case '--n':
        out.n = Number(next());
        break;
      case '--out-name':
        out.outName = next();
        break;
      case '--no-dry-run':
        out.includeDryRun = false;
        break;
      case '--runs-dir':
        out.runsDir = resolve(next());
        break;
      case '-h':
      case '--help':
        usage();
        break;
      default:
        console.error(`unknown arg: ${a}`);
        usage();
    }
  }
  return out;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const projectRoot = args.projectRoot ?? defaultProjectRoot();
  const evalRoot = resolveEvalRoot(projectRoot);
  const runsDir = args.runsDir ?? join(evalRoot, 'runs');

  if (args.cmd === 'run') {
    if (!args.task || !args.strategy) {
      console.error('error: run requires --task and --strategy');
      usage();
    }
    const result = await runEval({
      projectRoot,
      taskId: args.task,
      strategyId: args.strategy,
      maxTurns: args.maxTurns,
      timeoutSec: args.timeoutSec,
      allowShell: args.allowShell,
      allowWeb: args.allowWeb,
      dryRun: args.dryRun,
      plantCorrectAnswer: args.plant,
      runId: args.runId,
    });
    console.log(
      JSON.stringify(
        {
          run_dir: result.runDir,
          task_success: result.summary.task_success,
          turns_used: result.summary.turns_used,
          repeat_tool_rate: result.summary.repeat_tool_rate,
          hot_tokens_mean: result.summary.hot_tokens_mean,
          dry_run: result.manifest.dry_run,
          model: result.manifest.model,
        },
        null,
        2,
      ),
    );
    process.exit(result.summary.task_success ? 0 : 1);
  }

  if (args.cmd === 'aggregate') {
    const report = aggregateRuns({
      runsDir,
      taskId: args.task,
      strategyIds: args.strategies,
      includeDryRun: args.includeDryRun,
    });
    const outName =
      args.outName ??
      `aggregate_${args.task ?? 'all'}_${new Date().toISOString().slice(0, 10)}`;
    const { jsonPath, mdPath } = writeAggregateReport(
      report,
      join(evalRoot, 'reports'),
      outName,
    );
    console.log(JSON.stringify({ run_count: report.run_count, rows: report.rows, jsonPath, mdPath }, null, 2));
    console.error(`\nWrote ${mdPath}`);
    process.exit(0);
  }

  if (args.cmd === 'compare') {
    if (!args.task || !args.strategies?.length) {
      console.error('error: compare requires --task and --strategies a,b');
      usage();
    }
    const result = await compareStrategies({
      projectRoot,
      taskId: args.task,
      strategyIds: args.strategies,
      n: args.n,
      maxTurns: args.maxTurns,
      timeoutSec: args.timeoutSec,
      allowShell: args.allowShell,
      allowWeb: args.allowWeb,
      dryRun: args.dryRun,
      plantCorrectAnswer: args.plant,
      reportBasename: args.outName,
      includeDryRunInReport: args.includeDryRun,
    });
    console.log(
      JSON.stringify(
        {
          md_path: result.mdPath,
          json_path: result.jsonPath,
          rows: result.report.rows,
          run_count: result.report.run_count,
        },
        null,
        2,
      ),
    );
    console.error(`\nWrote ${result.mdPath}`);
    const allOk = result.results.every((r) => r.summary.task_success);
    process.exit(allOk ? 0 : 1);
  }

  usage();
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
