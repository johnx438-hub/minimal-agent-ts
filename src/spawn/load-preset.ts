import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

import type { SpawnPolicy, SpawnPresetConfig } from '../plugins/types.js';
import { mergeSpawnShellPolicy } from './shell-policy.js';
import type { ResolvedSpawnPreset } from './types.js';

const DEFAULT_SPAWN_MAX_TURNS = 15;
const DEFAULT_SPAWN_MAX_TURNS_CAP = 30;

function clampMaxTurns(
  value: number | undefined,
  policy?: SpawnPolicy,
): number {
  const fallback = policy?.max_turns_default ?? DEFAULT_SPAWN_MAX_TURNS;
  const cap = policy?.max_turns_cap ?? DEFAULT_SPAWN_MAX_TURNS_CAP;
  const raw = value ?? fallback;
  return Math.min(Math.max(1, Math.floor(raw)), Math.max(1, Math.floor(cap)));
}
/** Never expose recursive delegation tools to child agents. */
const FORBIDDEN_CHILD_TOOLS = new Set([
  'spawn_agent',
  'spawn_background',
  'code_review',
]);

function parseFrontmatter(raw: string): {
  meta: Record<string, string>;
  body: string;
} {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) {
    return { meta: {}, body: raw.trim() };
  }

  const meta: Record<string, string> = {};
  for (const line of match[1].split('\n')) {
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim().replace(/^['"]|['"]$/g, '');
    meta[key] = value;
  }

  return { meta, body: match[2].trim() };
}

function parseToolsList(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(/[,\s]+/)
    .map((t) => t.trim())
    .filter(Boolean)
    .filter((t) => !FORBIDDEN_CHILD_TOOLS.has(t));
}

export function resolvePresetFilePath(cwd: string, promptFile: string): string {
  return isAbsolute(promptFile) ? promptFile : resolve(cwd, promptFile);
}

export function resolveSpawnPreset(
  cwd: string,
  config: SpawnPresetConfig,
  policy?: SpawnPolicy,
): ResolvedSpawnPreset {
  const path = resolvePresetFilePath(cwd, config.prompt_file);
  if (!existsSync(path)) {
    throw new Error(`Spawn preset prompt file not found: ${path}`);
  }

  const raw = readFileSync(path, 'utf8');
  const { meta, body: mdBody } = parseFrontmatter(raw);

  let body = mdBody;
  let tools = config.tools?.filter((t) => !FORBIDDEN_CHILD_TOOLS.has(t)) ?? [];
  let maxTurns = config.max_turns;

  if (meta.tools) {
    tools = parseToolsList(meta.tools);
  }
  if (maxTurns === undefined && meta.max_turns) {
    const n = Number(meta.max_turns);
    if (Number.isFinite(n) && n > 0) maxTurns = Math.floor(n);
  }

  if (!body) {
    body = `You are spawn preset "${config.name}". Complete the delegated task and reply concisely.`;
  }

  const toolLine =
    tools.length > 0
      ? `\n\nAllowed tools: ${tools.join(', ')}. Do not call spawn_agent or spawn_background.`
      : '\n\nNo tools enabled for this preset.';

  const description =
    config.description?.trim() ||
    meta.description?.trim() ||
    `Preset agent: ${config.name}`;

  return {
    name: config.name,
    description,
    systemPrompt: `${body}${toolLine}`,
    tools,
    maxTurns: clampMaxTurns(maxTurns, policy),
    shellPolicy: mergeSpawnShellPolicy(policy?.shell, config.shell),
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