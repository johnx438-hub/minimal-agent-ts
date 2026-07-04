import { existsSync, unlinkSync, writeFileSync } from 'node:fs';

import { jobCancelRequestedPath } from './job-paths.js';
import { ensureJobDir } from './job-store.js';

export interface CancelRequestedRecord {
  v: 1;
  job_id: string;
  requested_at: string;
  source: string;
  pid: number;
}

export function writeCancelRequested(jobId: string, source = 'cli'): void {
  ensureJobDir(jobId);
  const record: CancelRequestedRecord = {
    v: 1,
    job_id: jobId,
    requested_at: new Date().toISOString(),
    source,
    pid: process.pid,
  };
  writeFileSync(jobCancelRequestedPath(jobId), `${JSON.stringify(record)}\n`, 'utf8');
}

export function isCancelRequested(jobId: string): boolean {
  return existsSync(jobCancelRequestedPath(jobId));
}

export function clearCancelRequested(jobId: string): void {
  const path = jobCancelRequestedPath(jobId);
  if (!existsSync(path)) return;
  unlinkSync(path);
}

/** Poll disk cancel marker; abort in-process runner when present. */
export function pollJobCancel(jobId: string, abortController: AbortController): boolean {
  if (abortController.signal.aborted) return true;
  if (!isCancelRequested(jobId)) return false;
  abortController.abort();
  return true;
}