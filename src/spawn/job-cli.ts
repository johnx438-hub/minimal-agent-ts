import { existsSync, readFileSync, unwatchFile, watchFile } from 'node:fs';

import { getJobRegistry } from './job-registry.js';
import { jobEventsPath } from './job-paths.js';
import {
  formatJobList,
  formatJobStatus,
  listSpawnJobs,
  type ListJobsOptions,
} from './job-query.js';
import { readJobMeta, type JobStatus, type SpawnJobMeta } from './job-store.js';

export type { JobListEntry, JobStatusDetail, ListJobsOptions } from './job-query.js';
export {
  countRunningJobs,
  formatJobEventsTail,
  formatJobList,
  formatJobListLine,
  formatJobLlmTag,
  formatJobStatus,
  getJobStatusDetail,
  isStaleJob,
  listSpawnJobs,
  toJobListEntry,
} from './job-query.js';

const TERMINAL_JOB_STATUSES = new Set<JobStatus>(['completed', 'failed', 'cancelled']);

export function killSpawnJob(jobId: string): { ok: boolean; message: string } {
  const meta = readJobMeta(jobId);
  if (!meta) {
    return { ok: false, message: `error: unknown job "${jobId}"` };
  }

  if (meta.status !== 'running' && meta.status !== 'queued') {
    return {
      ok: false,
      message: `error: job "${jobId}" is already ${meta.status}`,
    };
  }

  const outcome = getJobRegistry().cancel(jobId);
  if (!outcome) {
    return { ok: false, message: `error: failed to cancel "${jobId}"` };
  }

  if (outcome === 'requested') {
    return {
      ok: true,
      message: `cancel requested for ${jobId} (workspace/jobs/${jobId}/cancel.requested)`,
    };
  }

  return { ok: true, message: `cancelled ${jobId}` };
}

export function tailJobEvents(
  jobId: string,
  onLine: (line: string) => void,
  intervalMs = 500,
): () => void {
  const path = jobEventsPath(jobId);
  let offset = 0;
  let stopped = false;

  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    unwatchFile(path);
  };

  const flush = (): void => {
    if (stopped) return;
    if (!existsSync(path)) return;
    const content = readFileSync(path, 'utf8');
    if (content.length > offset) {
      const chunk = content.slice(offset);
      offset = content.length;
      for (const line of chunk.split('\n')) {
        const trimmed = line.trim();
        if (trimmed) onLine(trimmed);
      }
    }

    const meta = readJobMeta(jobId);
    if (meta && TERMINAL_JOB_STATUSES.has(meta.status)) {
      stop();
    }
  };

  flush();
  if (!stopped) {
    watchFile(path, { interval: intervalMs }, flush);
  }
  return stop;
}