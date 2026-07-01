import type { AgentStepEvent } from '../events.js';
import type { AgentConfig } from '../types.js';
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

export async function runSpawnAgent(opts: RunSpawnOptions): Promise<string> {
  const { preset, task, parentConfig } = opts;
  const depth = parentConfig.spawnDepth ?? 0;

  if (depth >= MAX_SPAWN_DEPTH) {
    return `error: spawn depth limit (${MAX_SPAWN_DEPTH}) reached`;
  }

  if (presetNeedsShell(preset) && !parentConfig.allowShell) {
    const gate = parentConfig.permissionGate;
    if (
      !gate ||
      !(await gate.ensureShell(parentConfig, `spawn preset "${preset.name}" needs run_shell`))
    ) {
      return `error: preset "${preset.name}" requires run_shell; enable shell or approve when prompted`;
    }
  }
  if (presetNeedsWeb(preset) && !parentConfig.allowWeb) {
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

  const childConfig: AgentConfig = {
    ...parentConfig,
    sessionId: undefined,
    maxTurns: preset.maxTurns,
    toolAllowlist: preset.tools.length > 0 ? preset.tools : undefined,
    spawnDepth: depth + 1,
  };

  const sink = parentConfig.nestedStepSink;
  const onStep = sink
    ? (event: AgentStepEvent) => {
        sink(event);
      }
    : undefined;

  console.log(`\n${'═'.repeat(60)}`);
  console.log(`spawn ▶ ${preset.name}`);
  console.log('═'.repeat(60));

  const { runAgent } = await import('../agent.js');

  try {
    const result = await runAgent({
      prompt: trimmed,
      config: childConfig,
      isolated: true,
      stream: process.env.STREAM !== '0',
      systemPrompt: preset.systemPrompt,
      signal: parentConfig.abortSignal,
      onStep,
    });

    console.log(`\nspawn ✓ ${preset.name}`);
    return result.text || '(empty reply from sub-agent)';
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`\nspawn ✗ ${preset.name}: ${msg}`);
    return `error: spawn failed: ${msg}`;
  }
}