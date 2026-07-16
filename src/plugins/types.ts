export type McpTransportKind = 'stdio' | 'streamable-http' | 'sse';

export interface McpServerConfig {
  name: string;
  enabled?: boolean;
  /**
   * Default: `stdio` when `command` is set; `streamable-http` when only `url` is set.
   * Use `sse` for legacy HTTP/SSE MCP servers.
   */
  transport?: McpTransportKind;
  /** stdio: executable (e.g. npx). Mutually exclusive with `url`. */
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  /** HTTP: MCP endpoint (streamable-http or sse). Mutually exclusive with `command`. */
  url?: string;
  /** Optional HTTP headers (e.g. Authorization). */
  headers?: Record<string, string>;
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

export interface WebSearchCachePolicy {
  enabled?: boolean;
  /** Relative to workspace root. Default `.cache/web-fetch`. */
  search_spill_dir?: string;
}

export interface WebSearchBudgetPolicy {
  max_external_per_task?: number;
  warn_after?: number;
}

export interface WebSearchPolicy {
  allowed?: boolean;
  /** v1: `ddgr` only; v2 may add `searxng`. */
  backend?: 'ddgr' | 'searxng';
  max_results_default?: number;
  max_results_cap?: number;
  ddgr_path?: string;
  cache?: WebSearchCachePolicy;
  budget?: WebSearchBudgetPolicy;
  domain_hints?: string[];
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

export type LlmWire = 'openai_chat';

export type CacheMode =
  | 'off'
  | 'implicit'
  | 'openrouter_sticky'
  | 'anthropic_breakpoints';

export interface CachePolicyConfig {
  mode?: CacheMode;
  session_id_from?: 'session_id' | 'fixed';
  session_id?: string;
  breakpoints?: Array<'system' | 'tools' | 'first_user'>;
  telemetry?: boolean;
}

export interface ApiProfileConfig {
  base_url: string;
  api_key_env: string;
  default_model: string;
  models?: string[];
  wire?: LlmWire;
  cache?: CachePolicyConfig;
  extra_body?: Record<string, unknown>;
  fallback_profiles?: string[];
  display_name?: string;
  reasoning_map?: Record<string, Record<string, unknown>>;
}

/** C5: constrain child-agent run_shell (spawnDepth > 0). */
export type SpawnShellMode = 'inherit' | 'allowlist' | 'deny_only';

export interface SpawnShellPolicy {
  /**
   * inherit — only deny_patterns (if any)
   * allowlist — must match allowed_prefixes; deny still applies
   * deny_only — only deny_patterns
   */
  mode?: SpawnShellMode;
  /** Command must start with one of these (after normalize / strip leading cd). */
  allowed_prefixes?: string[];
  /** Always-applied regex denylist (string patterns). */
  deny_patterns?: string[];
  /** Default timeout for child run_shell when caller omits timeout_ms. */
  timeout_ms_default?: number;
  /** Hard cap on timeout_ms / max_timeout_ms for child run_shell. */
  timeout_ms_cap?: number;
}

export interface SpawnPresetConfig {
  name: string;
  description?: string;
  prompt_file: string;
  tools: string[];
  max_turns?: number;
  /** G1-c: optional LLM profile + model override for this preset. */
  api_profile?: string;
  model?: string;
  /** C5: per-preset shell policy (merged over spawn_policy.shell). */
  shell?: SpawnShellPolicy;
}

export interface SpawnPolicy {
  /** Max concurrent spawn_agent runs (default 1). */
  max_parallel?: number;
  /** Default max_turns when preset omits it (default 15). */
  max_turns_default?: number;
  /** Upper bound on preset max_turns (default 30). */
  max_turns_cap?: number;
  /** C5: default shell policy for all child agents (preset.shell overrides). */
  shell?: SpawnShellPolicy;
}

export interface TranscriptPolicy {
  /** Write transcript sidecar on task complete (default true). */
  enabled?: boolean;
  /** Stop appending when file exceeds this size (default 16 MiB). */
  max_bytes_per_session?: number;
  /** Cap total assistant chars per task record (default 200k). */
  max_assistant_chars_per_task?: number;
  /** Include tool stub rows with action_id + preview (default true). */
  include_tool_stubs?: boolean;
}

export interface AgentPluginConfig {
  builtin_tools?: string[];
  /** Default main-agent api profile; `__env__` or first profile when omitted. */
  default_api_profile?: string;
  api_profiles?: Record<string, ApiProfileConfig>;
  /** User-defined spawn presets (MD prompts under e.g. agents/). */
  spawn_presets?: SpawnPresetConfig[];
  spawn_policy?: SpawnPolicy;
  mcp_servers?: McpServerConfig[];
  skills_dirs?: string[];
  mcp_policy?: McpPolicy;
  pointerize_policy?: PointerizePolicy;
  recall_policy?: RecallPolicy;
  web_fetch_policy?: WebFetchPolicy;
  web_search?: WebSearchPolicy;
  transcript_policy?: TranscriptPolicy;
  /** Skill names to prepend into system prompt for this session. */
  loaded_skills?: string[];
  /**
   * Named workflow registry: name → path (relative cwd or absolute).
   * SPEC_WORKFLOW W3: `--workflow review-loop` resolves here first.
   */
  workflows?: Record<string, string>;
  /** Extra directories to scan for `{name}.json` workflows (default includes ./workflows). */
  workflow_dirs?: string[];
  /**
   * SPEC_JOB_SESSION_NOTIFY: job/workflow complete → bridge notice + optional auto_run.
   */
  session_notify?: {
    bridge?: boolean;
    auto_run?: boolean;
    /** Prefer SystemEventKind values; string kept for JSON forward-compat. */
    auto_run_kinds?: Array<
      import('../hooks/system-event.js').SystemEventKind | string
    >;
    merge?: 'per_event' | 'debounce' | 'settle_only';
    debounce_ms?: number;
    max_digest_chars?: number;
  };
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
  call: (args: Record<string, unknown>, signal?: AbortSignal) => Promise<string>;
}