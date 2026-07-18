import type { SpawnPolicy, SpawnPresetConfig } from '../plugins/types.js';
import {
  resolvePromptFileCwd,
  resolveSpawnPresetConfig,
} from '../agent-profile.js';
import type { ResolvedSpawnPreset } from './types.js';

export { resolvePromptFileCwd as resolvePresetFilePath };

export function resolveSpawnPreset(
  cwd: string,
  config: SpawnPresetConfig,
  policy?: SpawnPolicy,
): ResolvedSpawnPreset {
  const profile = resolveSpawnPresetConfig(cwd, config, policy);
  return {
    name: profile.name,
    description: profile.description,
    systemPrompt: profile.systemPrompt,
    tools: profile.tools,
    maxTurns: profile.maxTurns,
    keepInlineTurns: profile.keepInlineTurns,
    pointerizeMode: profile.pointerizeMode,
    shellPolicy: profile.shellPolicy,
  };
}

export function loadSpawnPresets(
  cwd: string,
  configs: SpawnPresetConfig[] | undefined,
  policy?: SpawnPolicy,
): ResolvedSpawnPreset[] {
  if (!configs?.length) return [];

  const seen = new Set<string>();
  const out: ResolvedSpawnPreset[] = [];

  for (const cfg of configs) {
    const name = cfg.name?.trim();
    if (!name) continue;
    if (seen.has(name)) {
      throw new Error(`Duplicate spawn preset name: ${name}`);
    }
    seen.add(name);
    out.push(resolveSpawnPreset(cwd, cfg, policy));
  }

  return out;
}
