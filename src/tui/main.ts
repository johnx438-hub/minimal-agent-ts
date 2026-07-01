import 'dotenv/config';
import { resolve } from 'node:path';

import { AgentRuntime } from '../runner.js';
import { runTuiApp } from './app.js';

function parseTuiArgs(argv: string[]): {
  cwd: string;
  resumeSessionId?: string;
  resumeLatest: boolean;
  noShell: boolean;
  noWeb: boolean;
  allowWeb: boolean;
  loadHandoffFrom?: string;
} {
  let cwd = process.cwd();
  let resumeSessionId: string | undefined;
  let resumeLatest = false;
  let loadHandoffFrom: string | undefined;
  let noShell = false;
  let noWeb = false;
  let allowWeb = false;

  const cwdIdx = argv.indexOf('--cwd');
  if (cwdIdx >= 0 && argv[cwdIdx + 1]) {
    cwd = resolve(argv[cwdIdx + 1]);
    argv = [...argv.slice(0, cwdIdx), ...argv.slice(cwdIdx + 2)];
  }

  const resumeIdx = argv.indexOf('--resume');
  if (resumeIdx >= 0 && argv[resumeIdx + 1]) {
    resumeSessionId = argv[resumeIdx + 1];
    argv = [...argv.slice(0, resumeIdx), ...argv.slice(resumeIdx + 2)];
  }

  if (argv.includes('--resume-last')) {
    resumeLatest = true;
    argv = argv.filter((a) => a !== '--resume-last');
  }

  if (argv.includes('--no-shell')) {
    noShell = true;
  }
  if (argv.includes('--no-web')) {
    noWeb = true;
  }
  if (argv.includes('--allow-web')) {
    allowWeb = true;
  }

  const handoffIdx = argv.indexOf('--handoff');
  if (handoffIdx >= 0) {
    const next = argv[handoffIdx + 1];
    if (next && !next.startsWith('-')) {
      loadHandoffFrom = next;
      argv = [...argv.slice(0, handoffIdx), ...argv.slice(handoffIdx + 2)];
    } else {
      loadHandoffFrom = 'last';
      argv = [...argv.slice(0, handoffIdx), ...argv.slice(handoffIdx + 1)];
    }
  }

  return { cwd, resumeSessionId, resumeLatest, noShell, noWeb, allowWeb, loadHandoffFrom };
}

async function main(): Promise<void> {
  const opts = parseTuiArgs(process.argv.slice(2));

  const runtime = new AgentRuntime({
    cwd: opts.cwd,
    resumeSessionId: opts.resumeSessionId,
    resumeLatest: opts.resumeLatest,
    tuiMode: true,
    allowShell: opts.noShell ? false : undefined,
    allowWeb: opts.allowWeb,
    loadHandoffFrom: opts.loadHandoffFrom,
  });

  await runtime.initialize();

  await runTuiApp({
    runtime,
    noShell: opts.noShell,
    noWeb: opts.noWeb,
    allowWeb: opts.allowWeb,
  });
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});