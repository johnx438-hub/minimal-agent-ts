import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

import {
  jobDir,
  jobEventsPath,
  jobMetaPath,
  jobReportPath,
  jobResultPath,
  jobsDir,
  jobsIndexPath,
  relativeJobFile,
} from './job-paths.js';

export type JobStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

/** LLM binding snapshot on job meta (轨 G2-b); optional on legacy jobs. */
export interface SpawnJobLlmSnapshot {
  api_profile: string;
  model: string;
  llm_base_url?: string;
  cache_mode?: string;
}

export interface SpawnJobMeta {
  v: 1;
  job_id: string;
  parent_session_id: string;
  spawn_session_id: string;
  preset: string;
  task_preview: string;
  cwd: string;
  status: JobStatus;
  created_at: string;
  updated_at: string;
  output_paths: string[];
  pid: number;
  api_profile?: string;
  model?: string;
  llm_base_url?: string;
  cache_mode?: string;
}

export interface SpawnJobResultFile {
  v: 1;
  job_id: string;
  ok: boolean;
  summary_line: string;
  report_paths: string[];
  duration_ms: number;
  ended_at: string;
  error?: string;
}

export interface JobIndexEntry {
  job_id: string;
  parent_session_id: string;
  preset: string;
  status: JobStatus;
  created_at: string;
}

export type JobEventRecord = Record<string, unknown> & { t: string; at: string };

const META_VERSION = 1 as const;
const RESULT_VERSION = 1 as const;
const TASK_PREVIEW_MAX = 160;

export function taskPreview(task: string): string {
  const trimmed = task.trim();
  if (trimmed.length <= TASK_PREVIEW_MAX) return trimmed;
  return `${trimmed.slice(0, TASK_PREVIEW_MAX)}…`;
}

function ensureJobsRoot(): void {
  const dir = jobsDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

export function ensureJobDir(jobId: string): void {
  ensureJobsRoot();
  const dir = jobDir(jobId);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

export function defaultOutputPaths(jobId: string): string[] {
  return [relativeJobFile(jobId, 'report.md')];
}

export function writeJobMeta(meta: SpawnJobMeta): void {
  ensureJobDir(meta.job_id);
  writeFileSync(jobMetaPath(meta.job_id), `${JSON.stringify(meta, null, 2)}\n`, 'utf8');
}

export function readJobMeta(jobId: string): SpawnJobMeta | null {
  const path = jobMetaPath(jobId);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as SpawnJobMeta;
  } catch {
    return null;
  }
}

export function patchJobMeta(
  jobId: string,
  patch: Partial<Pick<SpawnJobMeta, 'status' | 'updated_at' | 'output_paths'>>,
): SpawnJobMeta | null {
  const current = readJobMeta(jobId);
  if (!current) return null;
  const next: SpawnJobMeta = {
    ...current,
    ...patch,
    updated_at: patch.updated_at ?? new Date().toISOString(),
  };
  writeJobMeta(next);
  return next;
}

export function appendJobEvent(jobId: string, event: Omit<JobEventRecord, 'at'> & { at?: string }): void {
  ensureJobDir(jobId);
  const line = JSON.stringify({
    ...event,
    at: event.at ?? new Date().toISOString(),
  });
  appendFileSync(jobEventsPath(jobId), `${line}\n`, 'utf8');
}

export function readJobEvents(jobId: string): JobEventRecord[] {
  const path = jobEventsPath(jobId);
  if (!existsSync(path)) return [];
  try {
    return readFileSync(path, 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line) as JobEventRecord);
  } catch {
    return [];
  }
}

export function appendJobIndex(entry: JobIndexEntry): void {
  ensureJobsRoot();
  appendFileSync(jobsIndexPath(), `${JSON.stringify(entry)}\n`, 'utf8');
}

export function readJobIndex(limit?: number): JobIndexEntry[] {
  const path = jobsIndexPath();
  if (!existsSync(path)) return [];
  try {
    const lines = readFileSync(path, 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    const slice = limit && limit > 0 ? lines.slice(-limit) : lines;
    const entries: JobIndexEntry[] = [];
    for (const line of slice) {
      try {
        entries.push(JSON.parse(line) as JobIndexEntry);
      } catch {
        /* skip malformed */
      }
    }
    return entries;
  } catch {
    return [];
  }
}

export function writeJobResult(result: SpawnJobResultFile): void {
  ensureJobDir(result.job_id);
  writeFileSync(jobResultPath(result.job_id), `${JSON.stringify(result, null, 2)}\n`, 'utf8');
}

export function readJobResult(jobId: string): SpawnJobResultFile | null {
  const path = jobResultPath(jobId);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as SpawnJobResultFile;
  } catch {
    return null;
  }
}

export function writeJobReport(jobId: string, content: string): void {
  ensureJobDir(jobId);
  writeFileSync(jobReportPath(jobId), content, 'utf8');
}

export function applyJobLlmSnapshot(
  meta: SpawnJobMeta,
  llm?: SpawnJobLlmSnapshot,
): SpawnJobMeta {
  if (!llm) return meta;
  return {
    ...meta,
    api_profile: llm.api_profile,
    model: llm.model,
    ...(llm.llm_base_url ? { llm_base_url: llm.llm_base_url } : {}),
    ...(llm.cache_mode ? { cache_mode: llm.cache_mode } : {}),
  };
}

export function buildInitialMeta(opts: {
  jobId: string;
  parentSessionId: string;
  spawnSessionId: string;
  preset: string;
  task: string;
  cwd: string;
  status?: JobStatus;
  outputPaths?: string[];
  llm?: SpawnJobLlmSnapshot;
}): SpawnJobMeta {
  const now = new Date().toISOString();
  const base: SpawnJobMeta = {
    v: META_VERSION,
    job_id: opts.jobId,
    parent_session_id: opts.parentSessionId,
    spawn_session_id: opts.spawnSessionId,
    preset: opts.preset,
    task_preview: taskPreview(opts.task),
    cwd: opts.cwd,
    status: opts.status ?? 'queued',
    created_at: now,
    updated_at: now,
    output_paths: opts.outputPaths ?? defaultOutputPaths(opts.jobId),
    pid: process.pid,
  };
  return applyJobLlmSnapshot(base, opts.llm);
}

export function buildJobResult(opts: {
  jobId: string;
  ok: boolean;
  text: string;
  reportPaths: string[];
  durationMs: number;
  error?: string;
}): SpawnJobResultFile {
  const reportHint =
    opts.reportPaths.length > 0 ? ` Full report: ${opts.reportPaths[0]}` : '';
  const summary =
    opts.ok
      ? `✅ ${opts.text.split('\n')[0]?.slice(0, 120) ?? 'job done'}.${reportHint}`
      : `❌ job failed: ${opts.error ?? opts.text.slice(0, 120)}`;

  return {
    v: RESULT_VERSION,
    job_id: opts.jobId,
    ok: opts.ok,
    summary_line: summary,
    report_paths: opts.reportPaths,
    duration_ms: opts.durationMs,
    ended_at: new Date().toISOString(),
    ...(opts.error ? { error: opts.error } : {}),
  };
}