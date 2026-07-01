import 'dotenv/config';
import { resolve } from 'node:path';

import { AgentRuntime } from '../runner.js';
import { runTuiApp } from './app.js';
import { runPiTuiApp } from './pi-app.js';

const SESSION_ID_RE = /^session_\d{14}$/;

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
  if (resumeIdx >= 0) {
    const next = argv[resumeIdx + 1];
    if (next && !next.startsWith('-')) {
      resumeSessionId = next;
      argv = [...argv.slice(0, resumeIdx), ...argv.slice(resumeIdx + 2)];
    } else {
      resumeLatest = true;
      argv = [...argv.slice(0, resumeIdx), ...argv.slice(resumeIdx + 1)];
    }
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

  const positional = argv.filter((a) => !a.startsWith('-'));
  if (!resumeSessionId && positional.length === 1 && SESSION_ID_RE.test(positional[0])) {
    resumeSessionId = positional[0];
  }

  return { cwd, resumeSessionId, resumeLatest, noShell, noWeb, allowWeb, loadHandoffFrom };
}

async function main(): Promise<void> {
  const opts = parseTuiArgs(process.argv.slice(2));

  const runtime = new AgentRuntime({
    cwd: opts.cwd,
    resumeSessionId: opts.resumeSessionId,
    resumeLatest: opts.resumeLatest,
    deferSession: !opts.resumeSessionId && !opts.resumeLatest,
    tuiMode: true,
    allowShell: opts.noShell ? false : undefined,
    allowWeb: opts.allowWeb,
    loadHandoffFrom: opts.loadHandoffFrom,
  });

  await runtime.initialize();

  const useReadline = process.env.TUI_BACKEND === 'readline';

  if (useReadline) {
    await runTuiApp({
      runtime,
      noShell: opts.noShell,
      noWeb: opts.noWeb,
      allowWeb: opts.allowWeb,
    });
  } else {
    await runPiTuiApp({
      runtime,
      noShell: opts.noShell,
      noWeb: opts.noWeb,
      allowWeb: opts.allowWeb,
    });
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});