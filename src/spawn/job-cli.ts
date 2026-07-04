import { existsSync, readFileSync, unwatchFile, watchFile } from 'node:fs';

import { getJobRegistry } from './job-registry.js';
import { jobEventsPath } from './job-paths.js';
import {
  readJobEvents,
  readJobMeta,
  readJobResult,
  type SpawnJobMeta,
} from './job-store.js';

const STALE_MS = 24 * 60 * 60 * 1000;

export interface ListJobsOptions {
  limit?: number;
  parentSessionId?: string;
  status?: SpawnJobMeta['status'];
  staleOnly?: boolean;
}

export function isStaleJob(meta: SpawnJobMeta, now = Date.now()): boolean {
  if (meta.status !== 'running' && meta.status !== 'queued') return false;
  const updated = Date.parse(meta.updated_at);
  if (!Number.isFinite(updated)) return false;
  return now - updated > STALE_MS;
}

export function listSpawnJobs(opts?: ListJobsOptions): SpawnJobMeta[] {
  const registry = getJobRegistry();
  const jobs = registry.list({
    limit: opts?.limit ?? 20,
    parentSessionId: opts?.parentSessionId,
    status: opts?.status,
  });
  if (!opts?.staleOnly) return jobs;
  return jobs.filter((meta) => isStaleJob(meta));
}

export function formatJobListLine(meta: SpawnJobMeta, stale = false): string {
  const staleTag = stale ? ' [stale]' : '';
  const preview =
    meta.task_preview.length > 48
      ? `${meta.task_preview.slice(0, 48)}…`
      : meta.task_preview;
  return `${meta.job_id}  ${meta.status.padEnd(10)}  ${meta.preset.padEnd(20)}  ${preview}${staleTag}`;
}

export function formatJobList(opts?: ListJobsOptions): string {
  const jobs = listSpawnJobs(opts);
  if (jobs.length === 0) {
    return opts?.staleOnly ? 'No stale jobs.' : 'No background jobs found.';
  }

  const header = 'JOB_ID                      STATUS      PRESET                TASK';
  const lines = jobs.map((meta) => formatJobListLine(meta, isStaleJob(meta)));
  return [header, ...lines].join('\n');
}

export function formatJobStatus(jobId: string, eventTail = 5): string | null {
  const meta = readJobMeta(jobId);
  if (!meta) return null;

  const parts: string[] = ['--- meta ---', JSON.stringify(meta, null, 2)];

  const events = readJobEvents(jobId);
  if (events.length > 0) {
    parts.push('', `--- last ${Math.min(eventTail, events.length)} events ---`);
    for (const event of events.slice(-eventTail)) {
      parts.push(JSON.stringify(event));
    }
  }

  const result = readJobResult(jobId);
  if (result) {
    parts.push('', '--- result ---', JSON.stringify(result, null, 2));
  }

  if (isStaleJob(meta)) {
    parts.push('', '(stale: running/queued with no update for >24h)');
  }

  return parts.join('\n');
}

export function killSpawnJob(jobId: string): { ok: boolean; message: string } {
  const meta = readJobMeta(jobId);
  if (!meta) {
    return { ok: false, message: `error: unknown job "${jobId}"` };
  }

  if (
    meta.status !== 'running' &&
    meta.status !== 'queued'
  ) {
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

  const flush = (): void => {
    if (!existsSync(path)) return;
    const content = readFileSync(path, 'utf8');
    if (content.length <= offset) return;
    const chunk = content.slice(offset);
    offset = content.length;
    for (const line of chunk.split('\n')) {
      const trimmed = line.trim();
      if (trimmed) onLine(trimmed);
    }
  };

  flush();
  watchFile(path, { interval: intervalMs }, flush);
  return () => unwatchFile(path);
}