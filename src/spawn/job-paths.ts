import { randomBytes } from 'node:crypto';
import { relative, resolve } from 'node:path';

import { getWorkspaceRoot } from '../workspace.js';

export function jobsDir(): string {
  return resolve(getWorkspaceRoot(), 'workspace', 'jobs');
}

export function jobsIndexPath(): string {
  return resolve(jobsDir(), 'index.jsonl');
}

export function jobDir(jobId: string): string {
  return resolve(jobsDir(), jobId);
}

export function jobMetaPath(jobId: string): string {
  return resolve(jobDir(jobId), 'meta.json');
}

export function jobEventsPath(jobId: string): string {
  return resolve(jobDir(jobId), 'events.jsonl');
}

export function jobResultPath(jobId: string): string {
  return resolve(jobDir(jobId), 'result.json');
}

export function jobReportPath(jobId: string): string {
  return resolve(jobDir(jobId), 'report.md');
}

/**
 * If absPath is cwd/workspace/jobs/<job_id>/report.md, return job_id.
 * Used to apply report size cap on write_file paths.
 */
export function tryParseJobReportPath(cwd: string, absPath: string): string | null {
  const root = resolve(cwd);
  const full = resolve(absPath);
  const rel = relative(root, full).replace(/\\/g, '/');
  const m = rel.match(/^workspace\/jobs\/(job_[A-Za-z0-9_-]+)\/report\.md$/i);
  return m?.[1] ?? null;
}

export function jobCancelRequestedPath(jobId: string): string {
  return resolve(jobDir(jobId), 'cancel.requested');
}

/** Workspace-relative path for tool / prompt references. */
export function relativeJobFile(jobId: string, filename: string): string {
  return `workspace/jobs/${jobId}/${filename}`;
}

export function newJobId(): string {
  const ts = Date.now().toString(36);
  const rand = randomBytes(2).toString('hex');
  return `job_${ts}_${rand}`;
}