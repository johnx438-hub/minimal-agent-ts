import type { AgentStepEvent } from '../events.js';
import { isAbortError } from '../events.js';
import { isCapabilityEnabled } from '../permission-gate.js';
import type { AgentConfig } from '../types.js';
import type { SpawnLifecycleEvent } from '../types.js';
import { getSpawnSemaphore } from './semaphore.js';
import { appendSpawnRunRecord, buildSpawnSessionId } from './session.js';
import type { ResolvedSpawnPreset } from './types.js';

export const MAX_SPAWN_DEPTH = 2;

export interface RunSpawnOptions {
  preset: ResolvedSpawnPreset;
  task: string;
  parentConfig: AgentConfig;
  /** Fixed virtual session id (background jobs reuse one id per job). */
  spawnSessionId?: string;
  /** Extra step sink; merged with parentConfig.nestedStepSink when both set. */
  jobOnStep?: (event: AgentStepEvent) => void;
}

function presetNeedsShell(preset: ResolvedSpawnPreset): boolean {
  return preset.tools.includes('run_shell');
}

function presetNeedsWeb(preset: ResolvedSpawnPreset): boolean {
  return preset.tools.includes('web_fetch');
}

function emitSpawnLifecycle(config: AgentConfig, event: SpawnLifecycleEvent): void {
  config.spawnLifecycle?.(event);
}

export async function runSpawnAgent(opts: RunSpawnOptions): Promise<string> {
  const { preset, task, parentConfig } = opts;
  const depth = parentConfig.spawnDepth ?? 0;

  if (depth >= MAX_SPAWN_DEPTH) {
    return `error: spawn depth limit (${MAX_SPAWN_DEPTH}) reached`;
  }

  if (presetNeedsShell(preset) && !isCapabilityEnabled(parentConfig, 'shell')) {
    const gate = parentConfig.permissionGate;
    if (
      !gate ||
      !(await gate.ensureShell(parentConfig, `spawn preset "${preset.name}" needs run_shell`))
    ) {
      if (parentConfig.abortSignal?.aborted) return '[aborted]';
      return `error: preset "${preset.name}" requires run_shell; enable shell or approve when prompted`;
    }
  }
  if (presetNeedsWeb(preset) && !isCapabilityEnabled(parentConfig, 'web')) {
    const gate = parentConfig.permissionGate;
    if (
      !gate ||
      !(await gate.ensureWeb(parentConfig, `spawn preset "${preset.name}" needs web_fetch`))
    ) {
      if (parentConfig.abortSignal?.aborted) return '[aborted]';
      return `error: preset "${preset.name}" requires web_fetch; enable web or approve when prompted`;
    }
  }

  const trimmed = task.trim();
  if (!trimmed) {
    return 'error: task is required';
  }

  if (parentConfig.abortSignal?.aborted) {
    return '[aborted]';
  }

  const release = await getSpawnSemaphore().acquire(parentConfig.abortSignal);
  try {
    if (parentConfig.abortSignal?.aborted) {
      return '[aborted]';
    }
    return await runSpawnAgentInner({
      preset,
      task: trimmed,
      parentConfig,
      depth,
      spawnSessionId: opts.spawnSessionId,
      jobOnStep: opts.jobOnStep,
    });
  } catch (err) {
    if (isAbortError(err)) {
      emitSpawnLifecycle(parentConfig, {
        phase: 'end',
        preset: preset.name,
        ok: false,
        detail: 'aborted',
      });
      return '[aborted]';
    }
    throw err;
  } finally {
    release();
  }
}

function recordSpawnRun(opts: {
  parentSessionId: string;
  spawnSessionId: string;
  preset: string;
  task: string;
  startedAt: number;
  ok: boolean;
  detail?: string;
}): void {
  appendSpawnRunRecord({
    spawn_session_id: opts.spawnSessionId,
    parent_session_id: opts.parentSessionId,
    preset: opts.preset,
    task: opts.task,
    started_at: opts.startedAt,
    ended_at: Date.now(),
    ok: opts.ok,
    detail: opts.detail,
  });
}

async function runSpawnAgentInner(opts: {
  preset: ResolvedSpawnPreset;
  task: string;
  parentConfig: AgentConfig;
  depth: number;
  spawnSessionId?: string;
  jobOnStep?: (event: AgentStepEvent) => void;
}): Promise<string> {
  const { preset, task, parentConfig, depth, spawnSessionId: fixedSpawnSessionId, jobOnStep } =
    opts;
  const parentSessionId = parentConfig.sessionId;
  const spawnSessionId =
    fixedSpawnSessionId ?? (parentSessionId ? buildSpawnSessionId(parentSessionId) : undefined);
  const startedAt = Date.now();
  const coldStorage = Boolean(parentSessionId && spawnSessionId);

  const childConfig: AgentConfig = {
    ...parentConfig,
    sessionId: spawnSessionId,
    spawnParentSessionId: coldStorage ? parentSessionId : undefined,
    maxTurns: preset.maxTurns,
    toolAllowlist: preset.tools.length > 0 ? preset.tools : undefined,
    spawnDepth: depth + 1,
    spawnLifecycle: undefined,
  };

  const sink = parentConfig.nestedStepSink;
  const onStep =
    sink || jobOnStep
      ? (event: AgentStepEvent) => {
          sink?.(event);
          jobOnStep?.(event);
        }
      : undefined;

  emitSpawnLifecycle(parentConfig, { phase: 'start', preset: preset.name });

  const { runAgent } = await import('../agent.js');

  try {
    const result = await runAgent({
      prompt: task,
      config: childConfig,
      sessionId: spawnSessionId,
      isolated: true,
      stream: process.env.STREAM !== '0',
      systemPrompt: preset.systemPrompt,
      signal: parentConfig.abortSignal,
      onStep,
    });

    if (result.text === '[aborted]') {
      if (coldStorage) {
        recordSpawnRun({
          parentSessionId: parentSessionId!,
          spawnSessionId: spawnSessionId!,
          preset: preset.name,
          task,
          startedAt,
          ok: false,
          detail: 'aborted',
        });
      }
      emitSpawnLifecycle(parentConfig, {
        phase: 'end',
        preset: preset.name,
        ok: false,
        detail: 'aborted',
      });
      return '[aborted]';
    }

    if (coldStorage) {
      recordSpawnRun({
        parentSessionId: parentSessionId!,
        spawnSessionId: spawnSessionId!,
        preset: preset.name,
        task,
        startedAt,
        ok: true,
      });
    }
    emitSpawnLifecycle(parentConfig, { phase: 'end', preset: preset.name, ok: true });
    return result.text || '(empty reply from sub-agent)';
  } catch (err) {
    if (isAbortError(err)) {
      if (coldStorage) {
        recordSpawnRun({
          parentSessionId: parentSessionId!,
          spawnSessionId: spawnSessionId!,
          preset: preset.name,
          task,
          startedAt,
          ok: false,
          detail: 'aborted',
        });
      }
      emitSpawnLifecycle(parentConfig, {
        phase: 'end',
        preset: preset.name,
        ok: false,
        detail: 'aborted',
      });
      return '[aborted]';
    }
    const msg = err instanceof Error ? err.message : String(err);
    if (coldStorage) {
      recordSpawnRun({
        parentSessionId: parentSessionId!,
        spawnSessionId: spawnSessionId!,
        preset: preset.name,
        task,
        startedAt,
        ok: false,
        detail: msg,
      });
    }
    emitSpawnLifecycle(parentConfig, {
      phase: 'end',
      preset: preset.name,
      ok: false,
      detail: msg,
    });
    return `error: spawn failed: ${msg}`;
  }
}