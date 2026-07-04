import { buildSpawnSessionId } from './session.js';
import {
  appendJobEvent,
  appendJobIndex,
  buildInitialMeta,
  patchJobMeta,
  readJobIndex,
  readJobMeta,
  type JobStatus,
  type SpawnJobMeta,
  writeJobMeta,
} from './job-store.js';
import { isCancelRequested, writeCancelRequested } from './job-cancel.js';
import { jobEventsPath, jobMetaPath, jobResultPath, newJobId } from './job-paths.js';
import { runSpawnJob, type SpawnJobResult } from './job-runner.js';
import type { ResolvedSpawnPreset } from './types.js';
import type { AgentConfig } from '../types.js';

export interface StartSpawnJobOptions {
  preset: ResolvedSpawnPreset;
  task: string;
  parentConfig: AgentConfig;
  outputPaths?: string[];
}

export interface SpawnJobHandle {
  jobId: string;
  metaPath: string;
  eventsPath: string;
  resultPath: string;
  abortController: AbortController;
  promise: Promise<SpawnJobResult>;
}

export interface ListSpawnJobsOptions {
  parentSessionId?: string;
  status?: JobStatus;
  limit?: number;
}

export type JobCancelOutcome = 'aborted' | 'requested' | false;

class JobRegistry {
  private readonly handles = new Map<string, SpawnJobHandle>();

  start(opts: StartSpawnJobOptions): SpawnJobHandle {
    const jobId = newJobId();
    const parentSessionId = opts.parentConfig.sessionId ?? 'unknown';
    const spawnSessionId = buildSpawnSessionId(parentSessionId);
    const abortController = new AbortController();

    const meta = buildInitialMeta({
      jobId,
      parentSessionId,
      spawnSessionId,
      preset: opts.preset.name,
      task: opts.task,
      cwd: opts.parentConfig.cwd,
      status: 'queued',
      outputPaths: opts.outputPaths,
    });
    writeJobMeta(meta);
    appendJobIndex({
      job_id: jobId,
      parent_session_id: parentSessionId,
      preset: opts.preset.name,
      status: meta.status,
      created_at: meta.created_at,
    });

    const promise = runSpawnJob({
      jobId,
      preset: opts.preset,
      task: opts.task,
      parentConfig: opts.parentConfig,
      abortController,
      spawnSessionId,
    }).finally(() => {
      this.handles.delete(jobId);
    });

    const handle: SpawnJobHandle = {
      jobId,
      metaPath: jobMetaPath(jobId),
      eventsPath: jobEventsPath(jobId),
      resultPath: jobResultPath(jobId),
      abortController,
      promise,
    };

    this.handles.set(jobId, handle);
    void promise;

    return handle;
  }

  get(jobId: string): SpawnJobMeta | null {
    return readJobMeta(jobId);
  }

  list(opts?: ListSpawnJobsOptions): SpawnJobMeta[] {
    const limit = opts?.limit ?? 50;
    const index = readJobIndex(limit * 2);
    const seen = new Set<string>();
    const metas: SpawnJobMeta[] = [];

    for (const entry of [...index].reverse()) {
      if (seen.has(entry.job_id)) continue;
      seen.add(entry.job_id);

      const meta = readJobMeta(entry.job_id);
      if (!meta) continue;
      if (opts?.parentSessionId && meta.parent_session_id !== opts.parentSessionId) {
        continue;
      }
      if (opts?.status && meta.status !== opts.status) {
        continue;
      }
      metas.push(meta);
      if (metas.length >= limit) break;
    }

    return metas;
  }

  cancel(jobId: string): JobCancelOutcome {
    const meta = readJobMeta(jobId);
    if (!meta || (meta.status !== 'running' && meta.status !== 'queued')) {
      return false;
    }

    const handle = this.handles.get(jobId);
    if (handle) {
      handle.abortController.abort();
      patchJobMeta(jobId, { status: 'cancelled' });
      appendJobEvent(jobId, { t: 'cancel', source: 'abort' });
      return 'aborted';
    }

    if (isCancelRequested(jobId)) {
      return 'requested';
    }

    writeCancelRequested(jobId, 'registry_miss');
    appendJobEvent(jobId, { t: 'cancel', source: 'cancel_requested' });
    return 'requested';
  }

  getHandle(jobId: string): SpawnJobHandle | undefined {
    return this.handles.get(jobId);
  }

  /** Test helper: simulate cross-process kill (no in-memory handle). */
  releaseHandleForTests(jobId: string): void {
    this.handles.delete(jobId);
  }
}

let registry: JobRegistry | null = null;

export function getJobRegistry(): JobRegistry {
  if (!registry) {
    registry = new JobRegistry();
  }
  return registry;
}

export function resetJobRegistryForTests(): void {
  registry = null;
}

export function releaseJobHandleForTests(jobId: string): void {
  getJobRegistry().releaseHandleForTests(jobId);
}