import type { AgentConfig, ToolDefinition } from '../types.js';
import { runSpawnAgent } from '../spawn/runner.js';
import type { ResolvedSpawnPreset } from '../spawn/types.js';

export function buildSpawnDefinitions(presets: ResolvedSpawnPreset[]): ToolDefinition[] {
  if (presets.length === 0) return [];

  const listing = presets
    .map((p) => `${p.name} (${p.description.slice(0, 60)})`)
    .join('; ');

  return [
    {
      type: 'function',
      function: {
        name: 'spawn_agent',
        description:
          `Delegate a focused sub-task to a preset agent (isolated context; only the final reply returns). Presets: ${listing}`,
        parameters: {
          type: 'object',
          properties: {
            preset: {
              type: 'string',
              description: `Preset name. One of: ${presets.map((p) => p.name).join(', ')}`,
            },
            task: {
              type: 'string',
              description: 'Clear task description for the sub-agent',
            },
          },
          required: ['preset', 'task'],
        },
      },
    },
  ];
}

export async function runSpawnTool(
  name: string,
  args: Record<string, unknown>,
  config: AgentConfig,
  presets: ResolvedSpawnPreset[],
): Promise<string | null> {
  if (name !== 'spawn_agent') return null;

  if ((config.spawnDepth ?? 0) > 0) {
    return 'error: spawn_agent is not available inside a spawned sub-agent';
  }

  if (presets.length === 0) {
    return 'error: no spawn presets configured in agent.json';
  }

  const presetName = String(args.preset ?? '').trim();
  const task = String(args.task ?? '').trim();

  if (!presetName) {
    return 'error: preset is required';
  }

  const preset = presets.find(
    (p) => p.name === presetName || p.name.toLowerCase() === presetName.toLowerCase(),
  );
  if (!preset) {
    return `error: unknown preset "${presetName}". Available: ${presets.map((p) => p.name).join(', ')}`;
  }

  return runSpawnAgent({ preset, task, parentConfig: config });
}