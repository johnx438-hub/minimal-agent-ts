#!/usr/bin/env node
/**
 * Eval CLI (E1)
 *
 *   npx tsx src/eval/cli.ts run --task state_chain_01 --strategy minimal_full
 *   npx tsx src/eval/cli.ts run --task state_chain_01 --strategy minimal_full --dry-run --plant
 *   npm run eval:run -- --task state_chain_01 --strategy minimal_full --dry-run --plant
 */

import { resolve } from 'node:path';

import { defaultProjectRoot, runEval } from './run.js';

function usage(): never {
  console.error(`Usage:
  eval run --task <id> --strategy <id> [options]
  eval score --run <run_dir>   (re-score existing workspace via task score.sh)

Options (run):
  --task <id>           Task under eval/tasks/
  --strategy <id>       Strategy under eval/strategies/
  --max-turns <n>       Override meta.max_turns
  --timeout-sec <n>     Abort run after N seconds
  --allow-shell         Enable shell tools
  --allow-web           Enable web tools
  --dry-run             No LLM; setup + score only
  --plant               With --dry-run, plant fixtures/answer.correct.json
  --project-root <dir>  Repo root with agent.json / .env (default: auto)
  --run-id <id>         Force output folder name under eval/runs/
`);
  process.exit(2);
}

function parseArgs(argv: string[]): {
  cmd: string;
  task?: string;
  strategy?: string;
  maxTurns?: number;
  timeoutSec?: number;
  allowShell: boolean;
  allowWeb: boolean;
  dryRun: boolean;
  plant: boolean;
  projectRoot?: string;
  runId?: string;
  runDir?: string;
} {
  const cmd = argv[0] ?? '';
  let task: string | undefined;
  let strategy: string | undefined;
  let maxTurns: number | undefined;
  let timeoutSec: number | undefined;
  let allowShell = false;
  let allowWeb = false;
  let dryRun = false;
  let plant = false;
  let projectRoot: string | undefined;
  let runId: string | undefined;
  let runDir: string | undefined;

  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) usage();
      return v;
    };
    switch (a) {
      case '--task':
        task = next();
        break;
      case '--strategy':
        strategy = next();
        break;
      case '--max-turns':
        maxTurns = Number(next());
        break;
      case '--timeout-sec':
        timeoutSec = Number(next());
        break;
      case '--allow-shell':
        allowShell = true;
        break;
      case '--allow-web':
        allowWeb = true;
        break;
      case '--dry-run':
        dryRun = true;
        break;
      case '--plant':
        plant = true;
        break;
      case '--project-root':
        projectRoot = resolve(next());
        break;
      case '--run-id':
        runId = next();
        break;
      case '--run':
        runDir = next();
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

  return {
    cmd,
    task,
    strategy,
    maxTurns,
    timeoutSec,
    allowShell,
    allowWeb,
    dryRun,
    plant,
    projectRoot,
    runId,
    runDir,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.cmd !== 'run' && args.cmd !== 'score') {
    usage();
  }

  if (args.cmd === 'score') {
    console.error('score-only re-entry: use bash eval/scripts/score-task.sh <task_id> for now');
    process.exit(2);
  }

  if (!args.task || !args.strategy) {
    console.error('error: --task and --strategy required');
    usage();
  }

  const projectRoot = args.projectRoot ?? defaultProjectRoot();
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

  const line = {
    run_dir: result.runDir,
    task_success: result.summary.task_success,
    turns_used: result.summary.turns_used,
    repeat_tool_rate: result.summary.repeat_tool_rate,
    hot_tokens_mean: result.summary.hot_tokens_mean,
    dry_run: result.manifest.dry_run,
    model: result.manifest.model,
  };
  console.log(JSON.stringify(line, null, 2));
  process.exit(result.summary.task_success ? 0 : 1);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
