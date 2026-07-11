import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';

import type { AgentPluginConfig, SpawnPresetConfig } from '../plugins/types.js';
import { resolvePresetFilePath } from './load-preset.js';
import type { ResolvedSpawnPreset } from './types.js';

export interface SpawnPresetEntry {
  name: string;
  description: string;
  tools: string[];
  maxTurns: number;
  promptFile: string;
  apiProfile?: string;
  model?: string;
  registered: boolean;
}

export interface OrphanAgentFile {
  path: string;
  relativePath: string;
  description?: string;
}

function configByName(
  configs: SpawnPresetConfig[] | undefined,
): Map<string, SpawnPresetConfig> {
  const map = new Map<string, SpawnPresetConfig>();
  for (const cfg of configs ?? []) {
    const name = cfg.name?.trim();
    if (name) map.set(name, cfg);
  }
  return map;
}

function readAgentDescription(path: string): string | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const raw = readFileSync(path, 'utf8');
    const match = raw.match(/^---\r?\n[\s\S]*?^description:\s*(.+)$/m);
    return match?.[1]?.trim().replace(/^['"]|['"]$/g, '');
  } catch {
    return undefined;
  }
}

/** Registered spawn presets with agent.json metadata. */
export function buildSpawnPresetEntries(
  cwd: string,
  pluginConfig: AgentPluginConfig,
  resolved: ResolvedSpawnPreset[],
): SpawnPresetEntry[] {
  const byName = configByName(pluginConfig.spawn_presets);
  return resolved.map((preset) => {
    const cfg = byName.get(preset.name);
    const promptFile = cfg
      ? relative(cwd, resolvePresetFilePath(cwd, cfg.prompt_file))
      : `agents/${preset.name}.md`;
    return {
      name: preset.name,
      description: preset.description,
      tools: preset.tools,
      maxTurns: preset.maxTurns,
      promptFile,
      apiProfile: cfg?.api_profile?.trim(),
      model: cfg?.model?.trim(),
      registered: true,
    };
  });
}

/** MD files under agents/ not referenced by spawn_presets. */
export function listOrphanAgentFiles(
  cwd: string,
  pluginConfig: AgentPluginConfig,
): OrphanAgentFile[] {
  const agentsDir = resolve(cwd, 'agents');
  if (!existsSync(agentsDir)) return [];

  const registered = new Set(
    (pluginConfig.spawn_presets ?? []).map((p) =>
      relative(cwd, resolvePresetFilePath(cwd, p.prompt_file)),
    ),
  );

  let names: string[] = [];
  try {
    names = readdirSync(agentsDir).filter((n) => n.endsWith('.md'));
  } catch {
    return [];
  }

  const orphans: OrphanAgentFile[] = [];
  for (const name of names.sort()) {
    const full = join(agentsDir, name);
    const rel = relative(cwd, full);
    if (registered.has(rel) || registered.has(`./${rel}`)) continue;
    orphans.push({
      path: full,
      relativePath: rel,
      description: readAgentDescription(full),
    });
  }
  return orphans;
}

export function formatSpawnPresetDetail(entry: SpawnPresetEntry): string {
  const lines = [
    `name: ${entry.name}`,
    `description: ${entry.description}`,
    `prompt: ${entry.promptFile}`,
    `max_turns: ${entry.maxTurns}`,
    `tools: ${entry.tools.length > 0 ? entry.tools.join(', ') : '(none)'}`,
  ];
  if (entry.apiProfile) {
    lines.push(`api_profile: ${entry.apiProfile}`);
  }
  if (entry.model) {
    lines.push(`model: ${entry.model}`);
  }
  lines.push('', 'invoke: spawn_agent(preset=…) or spawn_background(preset=…)');
  return lines.join('\n');
}

export function formatSpawnPresetListLine(entry: SpawnPresetEntry): string {
  const llm =
    entry.apiProfile || entry.model
      ? `${entry.apiProfile ?? 'inherit'}/${entry.model ?? 'default'}`
      : 'inherit';
  const tools =
    entry.tools.length > 0
      ? entry.tools.slice(0, 4).join(', ') + (entry.tools.length > 4 ? '…' : '')
      : '(no tools)';
  return `${entry.name.padEnd(22)}  turns=${String(entry.maxTurns).padEnd(2)}  ${llm.padEnd(24)}  ${tools}`;
}