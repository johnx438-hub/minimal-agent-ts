import { getJobRegistry } from './job-registry.js';
import {
  readJobEvents,
  readJobMeta,
  readJobResult,
  type JobEventRecord,
  type JobStatus,
  type SpawnJobMeta,
  type SpawnJobResultFile,
} from './job-store.js';

const STALE_MS = 24 * 60 * 60 * 1000;

export interface ListJobsOptions {
  limit?: number;
  parentSessionId?: string;
  status?: JobStatus;
  staleOnly?: boolean;
}

export interface JobListEntry {
  job_id: string;
  status: JobStatus;
  preset: string;
  llm_tag: string;
  task_preview: string;
  stale: boolean;
  created_at: string;
  updated_at: string;
}

export interface JobStatusDetail {
  meta: SpawnJobMeta;
  events_tail: JobEventRecord[];
  event_total: number;
  result: SpawnJobResultFile | null;
  stale: boolean;
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

export function countRunningJobs(jobs: SpawnJobMeta[]): number {
  return jobs.filter((meta) => meta.status === 'running' || meta.status === 'queued').length;
}

export function formatJobLlmTag(meta: SpawnJobMeta): string {
  if (!meta.api_profile && !meta.model) return '—';
  const profile = meta.api_profile ?? '?';
  const model = meta.model ?? '?';
  const tag = `${profile}/${model}`;
  return tag.length > 28 ? `${tag.slice(0, 27)}…` : tag;
}

export function toJobListEntry(meta: SpawnJobMeta): JobListEntry {
  return {
    job_id: meta.job_id,
    status: meta.status,
    preset: meta.preset,
    llm_tag: formatJobLlmTag(meta),
    task_preview: meta.task_preview,
    stale: isStaleJob(meta),
    created_at: meta.created_at,
    updated_at: meta.updated_at,
  };
}

export function formatJobListLine(meta: SpawnJobMeta, stale = false): string {
  const staleTag = stale ? ' [stale]' : '';
  const preview =
    meta.task_preview.length > 48
      ? `${meta.task_preview.slice(0, 48)}…`
      : meta.task_preview;
  const llm = formatJobLlmTag(meta).padEnd(28);
  return `${meta.job_id}  ${meta.status.padEnd(10)}  ${meta.preset.padEnd(20)}  ${llm}  ${preview}${staleTag}`;
}

export function formatJobList(opts?: ListJobsOptions): string {
  const jobs = listSpawnJobs(opts);
  if (jobs.length === 0) {
    return opts?.staleOnly ? 'No stale jobs.' : 'No background jobs found.';
  }

  const header =
    'JOB_ID                      STATUS      PRESET                LLM                           TASK';
  const lines = jobs.map((meta) => formatJobListLine(meta, isStaleJob(meta)));
  return [header, ...lines].join('\n');
}

export function getJobStatusDetail(jobId: string, eventTail = 5): JobStatusDetail | null {
  const meta = readJobMeta(jobId);
  if (!meta) return null;

  const events = readJobEvents(jobId);
  const tail = eventTail > 0 ? events.slice(-eventTail) : [];
  const result = readJobResult(jobId);

  return {
    meta,
    events_tail: tail,
    event_total: events.length,
    result,
    stale: isStaleJob(meta),
  };
}

export function formatJobStatus(jobId: string, eventTail = 5): string | null {
  const detail = getJobStatusDetail(jobId, eventTail);
  if (!detail) return null;

  const parts: string[] = ['--- meta ---', JSON.stringify(detail.meta, null, 2)];

  if (detail.events_tail.length > 0) {
    parts.push('', `--- last ${detail.events_tail.length} events ---`);
    for (const event of detail.events_tail) {
      parts.push(JSON.stringify(event));
    }
  }

  if (detail.result) {
    parts.push('', '--- result ---', JSON.stringify(detail.result, null, 2));
  }

  if (detail.stale) {
    parts.push('', '(stale: running/queued with no update for >24h)');
  }

  return parts.join('\n');
}

/** Full events log as newline-delimited JSON for TUI tail overlay. */
export function formatJobEventsTail(jobId: string, maxLines = 200): string | null {
  const meta = readJobMeta(jobId);
  if (!meta) return null;

  const events = readJobEvents(jobId);
  if (events.length === 0) {
    return `(no events for ${jobId} — status: ${meta.status})`;
  }

  const slice = maxLines > 0 ? events.slice(-maxLines) : events;
  const lines = slice.map((event) => JSON.stringify(event));
  const omitted = events.length - slice.length;
  const header =
    omitted > 0
      ? `--- ${jobId} · last ${slice.length} of ${events.length} events ---`
      : `--- ${jobId} · ${events.length} events ---`;
  return [header, ...lines].join('\n');
}