import type { AgentStepEvent } from '../events.js';
import type { AgentConfig } from '../types.js';
import { buildSpawnSessionId } from './session.js';
import {
  appendJobEvent,
  buildJobResult,
  patchJobMeta,
  readJobMeta,
  type JobEventRecord,
  type JobStatus,
  writeJobReport,
  writeJobResult,
} from './job-store.js';
import { clearCancelRequested, pollJobCancel } from './job-cancel.js';
import { jobReportPath, relativeJobFile } from './job-paths.js';
import { runSpawnAgent, type RunSpawnOptions } from './runner.js';
import type { ResolvedSpawnPreset } from './types.js';

const SHORT_REPORT_MAX_CHARS = 8_000;

export interface SpawnJobResult {
  jobId: string;
  ok: boolean;
  status: JobStatus;
  summaryLine: string;
  reportPaths: string[];
  durationMs: number;
  text: string;
  error?: string;
}

export interface RunSpawnJobOptions {
  jobId: string;
  preset: ResolvedSpawnPreset;
  task: string;
  parentConfig: AgentConfig;
  abortController: AbortController;
  spawnSessionId?: string;
}

export type SpawnRunnerFn = (opts: RunSpawnOptions) => Promise<string>;

let spawnRunnerOverride: SpawnRunnerFn | null = null;

export function setSpawnRunnerForTests(fn: SpawnRunnerFn | null): void {
  spawnRunnerOverride = fn;
}

export function resolveSpawnRunner(): SpawnRunnerFn {
  return spawnRunnerOverride ?? runSpawnAgent;
}

function compactAgentStepEvent(event: AgentStepEvent): Omit<JobEventRecord, 'at'> | null {
  switch (event.type) {
    case 'turn_start':
      return { t: 'turn_start', turn: event.turn };
    case 'tool_call': {
      const preview =
        event.args.length > 120 ? `${event.args.slice(0, 120)}…` : event.args;
      return { t: 'tool_call', turn: event.turn, name: event.name, preview };
    }
    case 'turn_io':
      return {
        t: 'turn_io',
        turn: event.turn,
        actions_saved: event.actions_saved,
      };
    default:
      return null;
  }
}

function classifySpawnResult(text: string, aborted: boolean): { ok: boolean; error?: string } {
  if (aborted || text === '[aborted]') {
    return { ok: false, error: 'cancelled' };
  }
  if (text.startsWith('error:')) {
    return { ok: false, error: text };
  }
  return { ok: true };
}

function maybeWriteShortReport(jobId: string, text: string, reportPaths: string[]): void {
  if (!text || text.length > SHORT_REPORT_MAX_CHARS) return;
  writeJobReport(jobId, text);
  if (!reportPaths.includes(relativeJobFile(jobId, 'report.md'))) {
    reportPaths.push(relativeJobFile(jobId, 'report.md'));
  }
}

export async function runSpawnJob(opts: RunSpawnJobOptions): Promise<SpawnJobResult> {
  const {
    jobId,
    preset,
    task,
    parentConfig,
    abortController,
    spawnSessionId: fixedSpawnSessionId,
  } = opts;

  const parentSessionId = parentConfig.sessionId ?? 'unknown';
  const spawnSessionId =
    fixedSpawnSessionId ?? buildSpawnSessionId(parentSessionId);
  const reportPaths = [relativeJobFile(jobId, 'report.md')];
  const startedAt = Date.now();

  patchJobMeta(jobId, { status: 'running' });
  appendJobEvent(jobId, { t: 'spawn_start', preset: preset.name });

  const jobOnStep = (event: AgentStepEvent): void => {
    if (pollJobCancel(jobId, abortController)) {
      appendJobEvent(jobId, { t: 'cancel', source: 'poll' });
    }
    const compact = compactAgentStepEvent(event);
    if (compact) {
      appendJobEvent(jobId, compact);
    }
  };

  const childParentConfig: AgentConfig = {
    ...parentConfig,
    abortSignal: abortController.signal,
    nestedStepSink: undefined,
    spawnLifecycle: undefined,
  };

  let text = '';
  let aborted = false;

  try {
    if (pollJobCancel(jobId, abortController)) {
      appendJobEvent(jobId, { t: 'cancel', source: 'poll' });
      aborted = true;
      text = '[aborted]';
    } else {
    text = await resolveSpawnRunner()({
      preset,
      task,
      parentConfig: childParentConfig,
      spawnSessionId,
      jobOnStep,
    });
    aborted = abortController.signal.aborted;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    text = `error: spawn failed: ${msg}`;
  }

  const durationMs = Date.now() - startedAt;
  const { ok, error } = classifySpawnResult(text, aborted);
  const status: JobStatus =
    aborted || error === 'cancelled' ? 'cancelled' : ok ? 'completed' : 'failed';

  if (ok) {
    maybeWriteShortReport(jobId, text, reportPaths);
  }

  const existingMeta = readJobMeta(jobId);
  const hintedPaths = existingMeta?.output_paths ?? [];
  const finalReportPaths =
    ok
      ? [...new Set([...hintedPaths, ...reportPaths])]
      : [];

  const resultFile = buildJobResult({
    jobId,
    ok,
    text,
    reportPaths: finalReportPaths,
    durationMs,
    error: status === 'cancelled' ? 'cancelled' : error,
  });
  writeJobResult(resultFile);
  patchJobMeta(jobId, { status, output_paths: finalReportPaths });

  appendJobEvent(jobId, {
    t: 'spawn_end',
    ok,
    wall_ms: durationMs,
    ...(error ? { detail: error } : {}),
  });

  clearCancelRequested(jobId);

  return {
    jobId,
    ok,
    status,
    summaryLine: resultFile.summary_line,
    reportPaths: resultFile.report_paths,
    durationMs,
    text,
    error: resultFile.error,
  };
}

/** Absolute report path for a job (may not exist until completion). */
export function absoluteJobReportPath(jobId: string): string {
  return jobReportPath(jobId);
}