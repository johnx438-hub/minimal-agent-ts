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
  /** True when report.md was clamped by MAX_JOB_REPORT_BYTES. */
  report_truncated?: boolean;
  /** Bytes actually written to report.md (after clamp). */
  report_bytes?: number;
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
  patch: Partial<
    Pick<
      SpawnJobMeta,
      'status' | 'updated_at' | 'output_paths' | 'report_truncated' | 'report_bytes'
    >
  >,
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

/** Replace index.jsonl contents (used by session delete compaction). */
export function writeJobIndex(entries: JobIndexEntry[]): void {
  ensureJobsRoot();
  const body =
    entries.length > 0
      ? `${entries.map((e) => JSON.stringify(e)).join('\n')}\n`
      : '';
  writeFileSync(jobsIndexPath(), body, 'utf8');
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

/**
 * Soft cap for job report.md (bytes, UTF-8).
 * Normal code-review / spawn reports stay far below this; stops runaway disk fill.
 */
export const MAX_JOB_REPORT_BYTES = 64 * 1024 * 1024;

export interface JobReportWriteResult {
  truncated: boolean;
  original_bytes: number;
  written_bytes: number;
}

/** Clamp report body to MAX_JOB_REPORT_BYTES, appending a truncation footer when needed. */
export function clampJobReportContent(content: string): JobReportWriteResult & {
  content: string;
} {
  const original_bytes = Buffer.byteLength(content, 'utf8');
  if (original_bytes <= MAX_JOB_REPORT_BYTES) {
    return {
      content,
      truncated: false,
      original_bytes,
      written_bytes: original_bytes,
    };
  }

  const footer =
    `\n\n---\n[report_truncated] original_bytes=${original_bytes} ` +
    `cap=${MAX_JOB_REPORT_BYTES}\n`;
  const footerBytes = Buffer.byteLength(footer, 'utf8');
  let bodyBudget = MAX_JOB_REPORT_BYTES - footerBytes;
  if (bodyBudget < 1024) {
    bodyBudget = Math.max(0, MAX_JOB_REPORT_BYTES - 128);
  }

  let body = Buffer.from(content, 'utf8').subarray(0, bodyBudget).toString('utf8');
  while (body.length > 0 && Buffer.byteLength(body, 'utf8') > bodyBudget) {
    body = body.slice(0, -1);
  }
  const out = `${body}${footer}`;
  return {
    content: out,
    truncated: true,
    original_bytes,
    written_bytes: Buffer.byteLength(out, 'utf8'),
  };
}

/**
 * Write report.md under the job dir, clamping to MAX_JOB_REPORT_BYTES.
 * Records report_truncated / report_bytes on meta when the job exists.
 */
export function writeJobReport(jobId: string, content: string): JobReportWriteResult {
  ensureJobDir(jobId);
  const clamped = clampJobReportContent(content);
  writeFileSync(jobReportPath(jobId), clamped.content, 'utf8');
  patchJobMeta(jobId, {
    report_truncated: clamped.truncated,
    report_bytes: clamped.written_bytes,
  });
  return {
    truncated: clamped.truncated,
    original_bytes: clamped.original_bytes,
    written_bytes: clamped.written_bytes,
  };
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