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
import { ensureSpawnOutputPaths } from './ensure-output-paths.js';
import { buildJobLlmMeta } from '../llm-profiles.js';
import { runSpawnJob, type SpawnJobResult } from './job-runner.js';
import type { ResolvedSpawnPreset } from './types.js';
import type { AgentConfig } from '../types.js';
import { notifySystemEvent, type SystemEvent } from '../hooks/system-event.js';

export interface StartSpawnJobOptions {
  preset: ResolvedSpawnPreset;
  task: string;
  parentConfig: AgentConfig;
  outputPaths?: string[];
  /** When set, use this id instead of generating a new one (e.g. code_review report paths). */
  jobId?: string;
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
    const jobId = opts.jobId ?? newJobId();
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
      llm: buildJobLlmMeta(opts.parentConfig, opts.preset.name),
    });
    ensureSpawnOutputPaths(opts.parentConfig.cwd, meta.output_paths);
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
    })
      .then((result) => {
        this.emitJobSettled(parentSessionId, jobId, opts.preset.name, result);
        return result;
      })
      .finally(() => {
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

  /** Count queued/running jobs for a parent session (disk meta + in-memory handles). */
  countActiveForParent(parentSessionId: string): {
    count: number;
    ids: string[];
  } {
    const ids: string[] = [];
    const seen = new Set<string>();

    for (const meta of this.list({ parentSessionId, limit: 100 })) {
      if (meta.status === 'running' || meta.status === 'queued') {
        if (!seen.has(meta.job_id)) {
          seen.add(meta.job_id);
          ids.push(meta.job_id);
        }
      }
    }
    // In-process handles may be slightly ahead of disk status
    for (const [id, handle] of this.handles) {
      if (seen.has(id)) continue;
      const meta = readJobMeta(id);
      if (meta?.parent_session_id === parentSessionId) {
        if (meta.status === 'running' || meta.status === 'queued') {
          seen.add(id);
          ids.push(id);
        }
      } else if (!meta) {
        // handle exists without readable meta — treat as active
        seen.add(id);
        ids.push(id);
      }
      void handle;
    }

    return { count: ids.length, ids };
  }

  private emitJobSettled(
    parentSessionId: string,
    jobId: string,
    preset: string,
    result: SpawnJobResult,
  ): void {
    const status = result.status;
    const kind =
      status === 'cancelled'
        ? 'job_cancelled'
        : status === 'failed' || !result.ok
          ? 'job_failed'
          : 'job_complete';

    const { count, ids } = this.countActiveForParent(parentSessionId);
    // Exclude self if still listed as active (race): prefer post-settle disk state
    const stillIds = ids.filter((id) => id !== jobId);
    const still = stillIds.length;

    const report_path = result.reportPaths?.[0];
    const ev: SystemEvent = {
      kind,
      timestamp: Date.now(),
      session_id: parentSessionId,
      event_id: `${jobId}:${status}`,
      job_id: jobId,
      preset,
      status:
        status === 'cancelled'
          ? 'cancelled'
          : status === 'failed' || !result.ok
            ? 'failed'
            : 'completed',
      ok: result.ok,
      summary_line: result.summaryLine,
      report_path,
      still_running: still,
      still_running_ids: stillIds,
    };
    notifySystemEvent(ev);

    if (still === 0) {
      notifySystemEvent({
        kind: 'jobs_all_settled',
        timestamp: Date.now(),
        session_id: parentSessionId,
        event_id: `all_settled:${parentSessionId}:${jobId}`,
        still_running: 0,
        still_running_ids: [],
      });
    }
  }

  get(jobId: string): SpawnJobMeta | null {
    return readJobMeta(jobId);
  }

  list(opts?: ListSpawnJobsOptions): SpawnJobMeta[] {
    const limit = opts?.limit ?? 50;
    const hasFilter = Boolean(opts?.parentSessionId || opts?.status);
    const index = hasFilter ? readJobIndex() : readJobIndex(limit * 2);
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

  /** Test teardown: abort every in-process job so mocks exit wait loops. */
  abortAllHandlesForTests(): void {
    for (const handle of this.handles.values()) {
      if (!handle.abortController.signal.aborted) {
        handle.abortController.abort();
      }
    }
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
  if (registry) {
    registry.abortAllHandlesForTests();
    registry = null;
  }
}

export function releaseJobHandleForTests(jobId: string): void {
  getJobRegistry().releaseHandleForTests(jobId);
}