export interface McpServerConfig {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  enabled?: boolean;
}

export interface McpPolicy {
  allow?: string[];
  deny?: string[];
}

export type PreviewMode = 'generic' | 'smart';

export interface PointerizePolicy {
  /** Recent tool turns kept inline (not pointerized). Default 2. */
  keep_inline_turns?: number;
  /** Min preview budget chars when pointerizing. */
  preview_min_chars?: number;
  /** Max preview budget chars on pointer cards. */
  preview_max_chars?: number;
  /** Fraction of byte_size used for preview budget. */
  preview_ratio?: number;
  /** generic = head/tail; smart = tool-aware summary for shell/grep/read/mcp. */
  preview_mode?: PreviewMode;
  /** Max lines on pointer card preview section. */
  preview_max_lines?: number;
  /** Max chars for one-line summary field. */
  summary_max_chars?: number;
}

export interface RecallPolicy {
  /** When recall has action_id and body is smaller, default format=full. Default 24000. */
  auto_full_max_chars?: number;
}

export interface WebFetchPolicy {
  /** Allowed host patterns: exact host, `*.example.com`, or `*`. Default `["*"]` when web fetch enabled. */
  allow_domains?: string[];
  deny_domains?: string[];
  default_timeout_ms?: number;
  cloak_timeout_ms?: number;
  max_chars?: number;
  /** Max raw HTTP/cloak response bytes before abort (default 5 MiB). */
  max_response_bytes?: number;
  /** Markdown larger than this spills to `.cache/web-fetch/` (default 512 KiB). */
  max_inline_bytes?: number;
  /** Write oversized Markdown to workspace instead of inline tool output. */
  spill_enabled?: boolean;
  /** Relative to workspace root. Default `.cache/web-fetch`. */
  spill_dir?: string;
  user_agent?: string;
  /** Enable L2 fallback via cloakFetch / CloakBrowser script. */
  cloak_fetch_enabled?: boolean;
  /** Path to cloak_fetch.sh or cloak_fetch.py (overrides auto-discovery). */
  cloak_fetch_script?: string;
  /** Python with cloakbrowser importable (env CLOAKBROWSER_PYTHON also supported). */
  cloak_browser_python?: string;
}

export interface SpawnPresetConfig {
  name: string;
  description?: string;
  prompt_file: string;
  tools: string[];
  max_turns?: number;
}

export interface SpawnPolicy {
  /** Max concurrent spawn_agent runs (default 1). */
  max_parallel?: number;
  /** Default max_turns when preset omits it (default 15). */
  max_turns_default?: number;
  /** Upper bound on preset max_turns (default 30). */
  max_turns_cap?: number;
}

export interface AgentPluginConfig {
  builtin_tools?: string[];
  /** User-defined spawn presets (MD prompts under e.g. agents/). */
  spawn_presets?: SpawnPresetConfig[];
  spawn_policy?: SpawnPolicy;
  mcp_servers?: McpServerConfig[];
  skills_dirs?: string[];
  mcp_policy?: McpPolicy;
  pointerize_policy?: PointerizePolicy;
  recall_policy?: RecallPolicy;
  web_fetch_policy?: WebFetchPolicy;
  /** Skill names to prepend into system prompt for this session. */
  loaded_skills?: string[];
}

export interface SkillDefinition {
  name: string;
  description: string;
  path: string;
  body: string;
}

export interface McpToolBinding {
  apiName: string;
  serverName: string;
  toolName: string;
  description: string;
  parameters: Record<string, unknown>;
  call: (args: Record<string, unknown>) => Promise<string>;
}