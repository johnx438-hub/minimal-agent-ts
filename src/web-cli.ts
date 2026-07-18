/**
 * Headless Web UI entry: same AgentRuntime, browser as UI.
 *
 *   npm run web -- --web-port 7788
 *   tsx src/web-cli.ts --allow-web --web-port 7788
 */

import 'dotenv/config';
import { resolve } from 'node:path';

import { AgentRuntime } from './runner.js';
import { printWebUiBanner, startWebUi } from './web/index.js';

function parseArgs(argv: string[]): {
  cwd: string;
  port: number;
  host: string;
  token?: string;
  allowShell: boolean;
  allowWeb: boolean;
  resumeSessionId?: string;
  resumeLatest: boolean;
} {
  let cwd = process.cwd();
  let port = 7788;
  let host = '127.0.0.1';
  let token: string | undefined;
  let allowShell = false;
  let allowWeb = false;
  let resumeSessionId: string | undefined;
  let resumeLatest = false;

  const next = [...argv];
  for (let i = 0; i < next.length; i++) {
    const a = next[i];
    if (a === '--cwd' && next[i + 1]) {
      cwd = resolve(next[++i]!);
    } else if (a === '--web-port' && next[i + 1]) {
      port = Number(next[++i]);
    } else if (a === '--web-host' && next[i + 1]) {
      host = next[++i]!;
    } else if (a === '--web-token' && next[i + 1]) {
      token = next[++i];
    } else if (a === '--allow-shell') {
      allowShell = true;
    } else if (a === '--allow-web') {
      allowWeb = true;
    } else if (a === '--resume' && next[i + 1] && !next[i + 1]!.startsWith('-')) {
      resumeSessionId = next[++i];
    } else if (a === '--resume-last') {
      resumeLatest = true;
    }
  }

  if (!Number.isFinite(port) || port <= 0) port = 7788;

  return {
    cwd,
    port,
    host,
    token,
    allowShell,
    allowWeb,
    resumeSessionId,
    resumeLatest,
  };
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));

  const runtime = new AgentRuntime({
    cwd: opts.cwd,
    resumeSessionId: opts.resumeSessionId,
    resumeLatest: opts.resumeLatest,
    deferSession: !opts.resumeSessionId && !opts.resumeLatest,
    tuiMode: false,
    allowShell: opts.allowShell,
    allowWeb: opts.allowWeb,
  });

  await runtime.initialize();

  const handle = await startWebUi({
    runtime,
    cwd: opts.cwd,
    host: opts.host,
    port: opts.port,
    token: opts.token,
  });

  printWebUiBanner(handle);
  console.error('Web UI running (Ctrl+C to stop). Agent tasks come from the browser.');

  const shutdown = async () => {
    console.error('\nShutting down Web UI…');
    try {
      runtime.abort();
    } catch {
      /* ignore */
    }
    await handle.close();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());

  // Keep process alive
  await new Promise(() => {});
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
