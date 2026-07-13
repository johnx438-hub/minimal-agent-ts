import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

import type { AgentPluginConfig } from './types.js';

const DEFAULT_BUILTIN_TOOLS = [
  'read_file',
  'write_file',
  'edit_file',
  'grep_search',
  'list_files',
  'diff_file',
  'recall_query',
  'invoke_skill',
  'run_shell',
  'git_status',
  'git_diff',
  'git_log',
];

function expandHome(path: string): string {
  return path.startsWith('~/') ? resolve(homedir(), path.slice(2)) : path;
}

export function defaultAgentPluginConfig(): AgentPluginConfig {
  return {
    builtin_tools: [...DEFAULT_BUILTIN_TOOLS],
    mcp_servers: [],
    skills_dirs: ['./skills', resolve(homedir(), '.minimal-agent/skills')],
    mcp_policy: { allow: ['*'], deny: [] },
    pointerize_policy: {
      keep_inline_turns: 2,
      preview_min_chars: 120,
      preview_max_chars: 480,
      preview_ratio: 0.04,
      preview_mode: 'smart',
      preview_max_lines: 5,
      summary_max_chars: 120,
    },
    recall_policy: { auto_full_max_chars: 24_000 },
    loaded_skills: [],
    spawn_presets: [],
  };
}

function mergeConfig(base: AgentPluginConfig, patch: Partial<AgentPluginConfig>): AgentPluginConfig {
  return {
    ...base,
    ...patch,
    builtin_tools: patch.builtin_tools ?? base.builtin_tools,
    mcp_servers: patch.mcp_servers ?? base.mcp_servers,
    skills_dirs: patch.skills_dirs ?? base.skills_dirs,
    mcp_policy: { ...base.mcp_policy, ...patch.mcp_policy },
    pointerize_policy: { ...base.pointerize_policy, ...patch.pointerize_policy },
    recall_policy: { ...base.recall_policy, ...patch.recall_policy },
    web_fetch_policy: { ...base.web_fetch_policy, ...patch.web_fetch_policy },
    web_search: { ...base.web_search, ...patch.web_search },
    loaded_skills: patch.loaded_skills ?? base.loaded_skills,
    spawn_presets: patch.spawn_presets ?? base.spawn_presets,
    spawn_policy: { ...base.spawn_policy, ...patch.spawn_policy },
    transcript_policy: { ...base.transcript_policy, ...patch.transcript_policy },
    default_api_profile: patch.default_api_profile ?? base.default_api_profile,
    api_profiles: patch.api_profiles ?? base.api_profiles,
  };
}

function readJsonFile(path: string): Partial<AgentPluginConfig> | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Partial<AgentPluginConfig>;
  } catch {
    return null;
  }
}

/** Load agent.json from cwd, then ~/.minimal-agent/agent.json. */
export function loadAgentPluginConfig(cwd: string): AgentPluginConfig {
  let config = defaultAgentPluginConfig();

  const paths = [resolve(cwd, 'agent.json')];
  if (process.env.NODE_ENV !== 'test') {
    paths.push(resolve(homedir(), '.minimal-agent/agent.json'));
  }

  for (const path of paths) {
    const patch = readJsonFile(path);
    if (patch) {
      config = mergeConfig(config, patch);
    }
  }

  config.skills_dirs = (config.skills_dirs ?? []).map((d) => {
    if (d.startsWith('~/') || d === '~') return expandHome(d);
    return resolve(cwd, d);
  });
  return config;
}