/**
 * Shared agent profile resolution for spawn presets and workflow roles (SPEC_WORKFLOW W1).
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve, sep } from 'node:path';

import type {
  SpawnPolicy,
  SpawnPresetConfig,
  SpawnShellPolicy,
} from './plugins/types.js';
import { mergeSpawnShellPolicy } from './spawn/shell-policy.js';

const DEFAULT_SPAWN_MAX_TURNS = 15;
const DEFAULT_SPAWN_MAX_TURNS_CAP = 30;

/** Never expose recursive delegation tools to child / workflow role agents. */
export const FORBIDDEN_CHILD_TOOLS = new Set([
  'spawn_agent',
  'spawn_background',
  'code_review',
]);

export interface AgentProfileInput {
  name?: string;
  /** Lookup spawn_presets[] or agents/<name>.md */
  preset?: string;
  prompt_file?: string;
  prompt?: string;
  tools?: string[];
  max_turns?: number;
  api_profile?: string;
  model?: string;
  shell?: SpawnShellPolicy;
  description?: string;
}

export interface ResolveAgentProfileOptions {
  cwd: string;
  spawnPresets?: SpawnPresetConfig[];
  spawnPolicy?: SpawnPolicy;
  /** When set, prompt_file may fall back relative to this workflow file. */
  workflowPath?: string;
  /**
   * spawn — system line says do not call spawn_*.
   * workflow — softer allowed-tools line.
   */
  childKind?: 'spawn' | 'workflow';
}

export interface ResolvedAgentProfile {
  name: string;
  description: string;
  systemPrompt: string;
  tools: string[];
  maxTurns: number;
  api_profile?: string;
  model?: string;
  shellPolicy?: SpawnShellPolicy;
}

export function clampProfileMaxTurns(
  value: number | undefined,
  policy?: SpawnPolicy,
): number {
  const fallback = policy?.max_turns_default ?? DEFAULT_SPAWN_MAX_TURNS;
  const cap = policy?.max_turns_cap ?? DEFAULT_SPAWN_MAX_TURNS_CAP;
  const raw = value ?? fallback;
  return Math.min(Math.max(1, Math.floor(raw)), Math.max(1, Math.floor(cap)));
}

export function stripForbiddenChildTools(tools: string[]): string[] {
  return tools.filter((t) => !FORBIDDEN_CHILD_TOOLS.has(t));
}

export function parseFrontmatter(raw: string): {
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

export function parseToolsList(raw: string | undefined): string[] {
  if (!raw) return [];
  return stripForbiddenChildTools(
    raw
      .split(/[,\s]+/)
      .map((t) => t.trim())
      .filter(Boolean),
  );
}

/** Reject paths that resolve outside project cwd (no JIT for profile files). */
export function assertProfilePathUnderCwd(
  cwd: string,
  absPath: string,
  inputLabel: string,
): string {
  const root = resolve(cwd);
  const target = resolve(absPath);
  if (target !== root && !target.startsWith(root + sep)) {
    throw new Error(`path escapes working directory: ${inputLabel}`);
  }
  return target;
}

/** Spawn-style: path relative to cwd (absolute ok), must stay under cwd. */
export function resolvePromptFileCwd(cwd: string, promptFile: string): string {
  const abs = isAbsolute(promptFile) ? promptFile : resolve(cwd, promptFile);
  return assertProfilePathUnderCwd(cwd, abs, promptFile);
}

/**
 * SPEC_WORKFLOW §5.2: try cwd-relative first, then relative to workflow file directory.
 * Each candidate is rejected if it escapes project cwd (path traversal).
 */
export function resolvePromptFileWithFallback(
  cwd: string,
  promptFile: string,
  workflowPath?: string,
): string {
  const candidates: string[] = [];
  candidates.push(isAbsolute(promptFile) ? promptFile : resolve(cwd, promptFile));
  if (workflowPath) {
    const base = dirname(workflowPath);
    candidates.push(
      isAbsolute(promptFile) ? promptFile : resolve(base, promptFile),
    );
  }

  let lastEscape: Error | null = null;
  for (const candidate of candidates) {
    try {
      const safe = assertProfilePathUnderCwd(cwd, candidate, promptFile);
      if (existsSync(safe)) return safe;
    } catch (err) {
      if (err instanceof Error && err.message.includes('escapes working directory')) {
        lastEscape = err;
        continue;
      }
      throw err;
    }
  }

  // Prefer not-found under cwd-relative path for loadMdFile; if only escapes, rethrow.
  try {
    return assertProfilePathUnderCwd(cwd, candidates[0]!, promptFile);
  } catch (err) {
    if (lastEscape) throw lastEscape;
    throw err;
  }
}

function findSpawnPresetConfig(
  presets: SpawnPresetConfig[] | undefined,
  name: string,
): SpawnPresetConfig | undefined {
  const needle = name.trim();
  if (!needle || !presets?.length) return undefined;
  return (
    presets.find((p) => p.name === needle) ??
    presets.find((p) => p.name.toLowerCase() === needle.toLowerCase())
  );
}

function loadMdFile(absPath: string): {
  body: string;
  meta: Record<string, string>;
} {
  if (!existsSync(absPath)) {
    throw new Error(`Agent profile prompt file not found: ${absPath}`);
  }
  const raw = readFileSync(absPath, 'utf8');
  return parseFrontmatter(raw);
}

function buildToolLine(
  tools: string[],
  childKind: 'spawn' | 'workflow',
): string {
  if (tools.length === 0) {
    return childKind === 'spawn'
      ? '\n\nNo tools enabled for this preset.'
      : '';
  }
  if (childKind === 'spawn') {
    return `\n\nAllowed tools: ${tools.join(', ')}. Do not call spawn_agent or spawn_background.`;
  }
  return `\n\nAllowed tools for this role: ${tools.join(', ')}.`;
}

/**
 * Resolve a spawn preset config (agent.json shape) into a full profile.
 * Preserves historical spawn merge: frontmatter `tools` wins over JSON tools when present.
 */
export function resolveSpawnPresetConfig(
  cwd: string,
  config: SpawnPresetConfig,
  policy?: SpawnPolicy,
): ResolvedAgentProfile {
  const path = resolvePromptFileCwd(cwd, config.prompt_file);
  const { meta, body: mdBody } = loadMdFile(path);

  let body = mdBody;
  let tools = stripForbiddenChildTools(config.tools ?? []);
  let maxTurns = config.max_turns;
  let apiProfile = config.api_profile;
  let model = config.model;

  if (meta.tools) {
    tools = parseToolsList(meta.tools);
  }
  if (maxTurns === undefined && meta.max_turns) {
    const n = Number(meta.max_turns);
    if (Number.isFinite(n) && n > 0) maxTurns = Math.floor(n);
  }
  if (!apiProfile && meta.api_profile) apiProfile = meta.api_profile;
  if (!model && meta.model) model = meta.model;

  if (!body) {
    body = `你是 spawn 预设「${config.name}」子 Agent。Complete the delegated task and reply concisely.`;
  }

  const description =
    config.description?.trim() ||
    meta.description?.trim() ||
    `Preset agent: ${config.name}`;

  return {
    name: config.name,
    description,
    systemPrompt: `${body}${buildToolLine(tools, 'spawn')}`,
    tools,
    maxTurns: clampProfileMaxTurns(maxTurns, policy),
    api_profile: apiProfile,
    model,
    shellPolicy: mergeSpawnShellPolicy(policy?.shell, config.shell),
  };
}

/**
 * Unified profile resolve for workflow roles (and optional direct callers).
 * - `preset` → spawn_presets or agents/<name>.md
 * - Role-level `tools` **replaces** preset tools when provided (SPEC §4.3)
 * - prompt_file: cwd then workflow dir
 */
export function resolveAgentProfile(
  input: AgentProfileInput,
  opts: ResolveAgentProfileOptions,
): ResolvedAgentProfile {
  const childKind = opts.childKind ?? 'workflow';
  const policy = opts.spawnPolicy;
  const displayName =
    input.name?.trim() || input.preset?.trim() || 'agent';

  let body = input.prompt?.trim() ?? '';
  let tools: string[] | undefined = input.tools
    ? stripForbiddenChildTools(input.tools)
    : undefined;
  let maxTurns = input.max_turns;
  let apiProfile = input.api_profile;
  let model = input.model;
  let description = input.description?.trim();
  let shellFromPreset: SpawnShellPolicy | undefined;
  let shellFromRole = input.shell;
  let loadedFromPreset = false;

  if (input.preset?.trim()) {
    const presetName = input.preset.trim();
    const cfg = findSpawnPresetConfig(opts.spawnPresets, presetName);
    if (cfg) {
      const base = resolveSpawnPresetConfig(opts.cwd, cfg, policy);
      loadedFromPreset = true;
      if (!body) body = stripToolLine(base.systemPrompt);
      if (tools === undefined) tools = [...base.tools];
      if (maxTurns === undefined) maxTurns = base.maxTurns;
      if (!apiProfile) apiProfile = base.api_profile;
      if (!model) model = base.model;
      if (!description) description = base.description;
      shellFromPreset = base.shellPolicy;
    } else {
      const agentMd = resolvePromptFileCwd(
        opts.cwd,
        `agents/${presetName}.md`,
      );
      if (!existsSync(agentMd)) {
        const known =
          opts.spawnPresets?.map((p) => p.name).join(', ') || '(none)';
        throw new Error(
          `Unknown agent preset "${presetName}". Not in spawn_presets and no ${agentMd}. Known presets: ${known}`,
        );
      }
      const { meta, body: mdBody } = loadMdFile(agentMd);
      loadedFromPreset = true;
      if (!body && mdBody) body = mdBody;
      if (tools === undefined && meta.tools) tools = parseToolsList(meta.tools);
      if (maxTurns === undefined && meta.max_turns) {
        const n = Number(meta.max_turns);
        if (Number.isFinite(n) && n > 0) maxTurns = Math.floor(n);
      }
      if (!apiProfile && meta.api_profile) apiProfile = meta.api_profile;
      if (!model && meta.model) model = meta.model;
      if (!description && meta.description) description = meta.description;
    }
  }

  if (input.prompt_file) {
    const path = resolvePromptFileWithFallback(
      opts.cwd,
      input.prompt_file,
      opts.workflowPath,
    );
    const { meta, body: mdBody } = loadMdFile(path);
    if (mdBody) body = mdBody;
    // Frontmatter tools fill when role did not set tools[] (preset tools already applied above).
    if (tools === undefined && meta.tools) {
      tools = parseToolsList(meta.tools);
    }
    // Non-preset path: also take max_turns / model / api_profile from frontmatter.
    // When loadedFromPreset, those fields stay from the preset unless role JSON set them.
    if (!loadedFromPreset) {
      if (maxTurns === undefined && meta.max_turns) {
        const n = Number(meta.max_turns);
        if (Number.isFinite(n) && n > 0) maxTurns = Math.floor(n);
      }
      if (!apiProfile && meta.api_profile) apiProfile = meta.api_profile;
      if (!model && meta.model) model = meta.model;
      if (!description && meta.description) description = meta.description;
    }
  }

  if (input.prompt?.trim()) {
    body = input.prompt.trim();
  }

  // Explicit role tools always win when provided
  if (input.tools) {
    tools = stripForbiddenChildTools(input.tools);
  }

  tools = tools ?? [];

  if (!body) {
    body =
      childKind === 'spawn'
        ? `你是 spawn 预设「${displayName}」子 Agent。Complete the delegated task and reply concisely.`
        : `你是多步 workflow 中的「${displayName}」角色。Complete your part and reply clearly.`;
  }

  const shellPolicy = shellFromRole
    ? mergeSpawnShellPolicy(
        shellFromPreset ?? policy?.shell,
        shellFromRole,
      )
    : shellFromPreset ??
      (policy?.shell ? mergeSpawnShellPolicy(policy.shell, undefined) : undefined);

  return {
    name: displayName,
    description: description || `Agent profile: ${displayName}`,
    systemPrompt: `${body}${buildToolLine(tools, childKind)}`,
    tools,
    maxTurns: clampProfileMaxTurns(maxTurns, policy),
    api_profile: apiProfile,
    model,
    shellPolicy,
  };
}

/** Remove spawn/workflow tool footer lines for re-composition. */
function stripToolLine(systemPrompt: string): string {
  return systemPrompt
    .replace(/\n\nAllowed tools:[\s\S]*$/u, '')
    .replace(/\n\nAllowed tools for this role:[\s\S]*$/u, '')
    .replace(/\n\nNo tools enabled for this preset\.\s*$/u, '')
    .trim();
}
