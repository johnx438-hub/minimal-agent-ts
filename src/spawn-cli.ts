import { setWorkspaceRoot } from './workspace.js';
import {
  formatJobList,
  formatJobStatus,
  killSpawnJob,
  tailJobEvents,
  type ListJobsOptions,
} from './spawn/job-cli.js';
import type { JobStatus } from './spawn/job-store.js';

function usage(): void {
  console.error(`Usage:
  spawn-cli list [--stale] [--limit N] [--status STATUS]
  spawn-cli status <job_id>
  spawn-cli kill <job_id>
  spawn-cli tail <job_id>`);
}

function parseListOptions(argv: string[]): ListJobsOptions {
  const opts: ListJobsOptions = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--stale') {
      opts.staleOnly = true;
      continue;
    }
    if (arg === '--limit' && argv[i + 1]) {
      opts.limit = Math.max(1, Number(argv[++i]));
      continue;
    }
    if (arg === '--status' && argv[i + 1]) {
      opts.status = argv[++i] as JobStatus;
      continue;
    }
  }
  return opts;
}

function main(): void {
  setWorkspaceRoot(process.cwd());

  const [, , command, ...rest] = process.argv;
  if (!command) {
    usage();
    process.exit(1);
  }

  switch (command) {
    case 'list': {
      console.log(formatJobList(parseListOptions(rest)));
      return;
    }
    case 'status': {
      const jobId = rest[0]?.trim();
      if (!jobId) {
        console.error('error: job_id required');
        process.exit(1);
      }
      const text = formatJobStatus(jobId);
      if (!text) {
        console.error(`error: unknown job "${jobId}"`);
        process.exit(1);
      }
      console.log(text);
      return;
    }
    case 'kill': {
      const jobId = rest[0]?.trim();
      if (!jobId) {
        console.error('error: job_id required');
        process.exit(1);
      }
      const result = killSpawnJob(jobId);
      if (!result.ok) {
        console.error(result.message);
        process.exit(1);
      }
      console.log(result.message);
      return;
    }
    case 'tail': {
      const jobId = rest[0]?.trim();
      if (!jobId) {
        console.error('error: job_id required');
        process.exit(1);
      }
      const stop = tailJobEvents(jobId, (line) => console.log(line));
      process.on('SIGINT', () => {
        stop();
        process.exit(0);
      });
      return;
    }
    default:
      usage();
      process.exit(1);
  }
}

main();