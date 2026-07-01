import type { AgentStepEvent } from '../events.js';
import { isCapabilityEnabled } from '../permission-gate.js';
import type { AgentConfig } from '../types.js';
import type { SpawnLifecycleEvent } from '../types.js';
import { getSpawnSemaphore } from './semaphore.js';
import type { ResolvedSpawnPreset } from './types.js';

export const MAX_SPAWN_DEPTH = 2;

export interface RunSpawnOptions {
  preset: ResolvedSpawnPreset;
  task: string;
  parentConfig: AgentConfig;
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
      return `error: preset "${preset.name}" requires run_shell; enable shell or approve when prompted`;
    }
  }
  if (presetNeedsWeb(preset) && !isCapabilityEnabled(parentConfig, 'web')) {
    const gate = parentConfig.permissionGate;
    if (
      !gate ||
      !(await gate.ensureWeb(parentConfig, `spawn preset "${preset.name}" needs web_fetch`))
    ) {
      return `error: preset "${preset.name}" requires web_fetch; enable web or approve when prompted`;
    }
  }

  const trimmed = task.trim();
  if (!trimmed) {
    return 'error: task is required';
  }

  const release = await getSpawnSemaphore().acquire();
  try {
    return await runSpawnAgentInner({ preset, task: trimmed, parentConfig, depth });
  } finally {
    release();
  }
}

async function runSpawnAgentInner(opts: {
  preset: ResolvedSpawnPreset;
  task: string;
  parentConfig: AgentConfig;
  depth: number;
}): Promise<string> {
  const { preset, task, parentConfig, depth } = opts;

  const childConfig: AgentConfig = {
    ...parentConfig,
    sessionId: undefined,
    maxTurns: preset.maxTurns,
    toolAllowlist: preset.tools.length > 0 ? preset.tools : undefined,
    spawnDepth: depth + 1,
    spawnLifecycle: undefined,
  };

  const sink = parentConfig.nestedStepSink;
  const onStep = sink
    ? (event: AgentStepEvent) => {
        sink(event);
      }
    : undefined;

  emitSpawnLifecycle(parentConfig, { phase: 'start', preset: preset.name });

  const { runAgent } = await import('../agent.js');

  try {
    const result = await runAgent({
      prompt: task,
      config: childConfig,
      isolated: true,
      stream: process.env.STREAM !== '0',
      systemPrompt: preset.systemPrompt,
      signal: parentConfig.abortSignal,
      onStep,
    });

    emitSpawnLifecycle(parentConfig, { phase: 'end', preset: preset.name, ok: true });
    return result.text || '(empty reply from sub-agent)';
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    emitSpawnLifecycle(parentConfig, {
      phase: 'end',
      preset: preset.name,
      ok: false,
      detail: msg,
    });
    return `error: spawn failed: ${msg}`;
  }
}