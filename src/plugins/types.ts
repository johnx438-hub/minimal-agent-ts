export type McpTransportKind = 'stdio' | 'streamable-http' | 'sse';

/**
 * Machine-to-machine OAuth for HTTP MCP (client_credentials).
 * Prefer `*_env` so secrets stay in `.env`, not agent.json.
 */
export interface McpOAuthClientCredentials {
  type: 'client_credentials';
  /** Literal client_id (avoid in committed configs). */
  client_id?: string;
  /** Literal client_secret (avoid in committed configs). */
  client_secret?: string;
  /** Read client_id from process.env[name]. */
  client_id_env?: string;
  /** Read client_secret from process.env[name]. */
  client_secret_env?: string;
  /** Optional space-separated or single scope string. */
  scope?: string;
  /** OAuth client_name metadata (default: minimal-agent:&lt;server&gt;). */
  client_name?: string;
  /**
   * Token cache file. Default: `$AGENT_HOME/mcp-oauth/<server>.json`
   * (or ~/.minimal-agent/mcp-oauth/…). Relative paths resolve under cwd.
   */
  token_store?: string;
}

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
  /** Optional HTTP headers (e.g. static Authorization Bearer). */
  headers?: Record<string, string>;
  /**
   * OAuth for streamable-http / sse. client_credentials uses SDK
   * ClientCredentialsProvider + optional token file cache.
   * Do not combine with stdio.
   */
  oauth?: McpOAuthClientCredentials;
}

export interface McpPolicy {
  allow?: string[];
  deny?: string[];
}

export type PreviewMode = 'generic' | 'smart';

/** Per-tool pointerize override (SPEC_POINTERIZE_SCOPE Phase 1). */
export type PointerizeToolMode = 'default' | 'never';

export interface PointerizeToolOverride {
  /** never = do not pointerize this tool; default = use POINTER_RULES + keep window. */
  mode?: PointerizeToolMode;
  /** Override global keep_inline_turns for this tool only. */
  keep_inline_turns?: number;
}

/** window = sliding keep; hold = no pointerize until budget pressure (P2). */
export type PointerizeMode = 'window' | 'hold';

export interface PointerizePolicy {
  /** Recent tool turns kept inline (not pointerized). Default 2. */
  keep_inline_turns?: number;
  /** Per-tool mode / keep window (e.g. recall_query never). */
  tool_overrides?: Record<string, PointerizeToolOverride>;
  /**
   * When estimateTokens > ratio * usable context, force pointerize even in hold/focus.
   * Default 0.75 (SPEC_POINTERIZE_SCOPE P2).
   */
  soft_force_ratio?: number;
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

/**
 * Optional context budget / lifecycle knobs (SPEC_CONTEXT_POLICY).
 * All fields optional; omit → source-code defaults (bit-identical).
 * Prefer {@link import('../context/policy-config.js').normalizeContextPolicy} at use sites.
 */
export interface ContextBudgetPolicy {
  system_pct?: number;
  current_pct?: number;
  recent_pct?: number;
  mid_pct?: number;
  early_pct?: number;
  recent_max_tokens?: number;
  mid_max_summaries?: number;
}

export interface ContextHeavyCompressionPolicy {
  /** First heavy event vs usable context. Default 0.8. */
  first_ratio?: number;
  /** Repeat heavy vs usable (hysteresis). Default 0.9. */
  repeat_ratio?: number;
}

export interface ContextProtectPolicy {
  /** Raw-estimate token window protected from prune. Default 140_000. */
  recent_tokens?: number;
  /** Trailing user turns always protected. Default 2. */
  user_turns?: number;
}

export interface ContextPrunePolicy {
  min_savings_tokens?: number;
  max_pointer_compact_per_turn?: number;
}

export interface ContextTokenCalibratorPolicy {
  alpha?: number;
  scale_min?: number;
  scale_max?: number;
  min_raw?: number;
}

/** Advanced: changing chars_per_token retunes every estimate (tests + thresholds). */
export interface ContextEstimatePolicy {
  chars_per_token?: number;
}

export interface ContextResumePolicy {
  min_history_tokens?: number;
  /** When true, resume shouldCompress / history slice use calibrator.apply. Default false. */
  apply_calibrator?: boolean;
}

export interface ContextPolicy {
  budget?: ContextBudgetPolicy;
  heavy_compression?: ContextHeavyCompressionPolicy;
  protect?: ContextProtectPolicy;
  prune?: ContextPrunePolicy;
  token_calibrator?: ContextTokenCalibratorPolicy;
  estimate?: ContextEstimatePolicy;
  resume?: ContextResumePolicy;
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
  /** Sticky scheduling via body.prompt_cache_key (Moonshot/Kimi). */
  | 'prompt_cache_key'
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
  /**
   * When true, re-send stored assistant `reasoning_content` on subsequent
   * turns (Kimi Preserved Thinking / prefix cache). Default false.
   */
  preserve_reasoning?: boolean;
  /** When false, materialize may still attach images only if vision.enabled; used as soft gate. */
  supports_vision?: boolean;
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
  /**
   * Override pointerize keep window for this child agent (SPEC_POINTERIZE_SCOPE).
   * Reviewer-style presets often want a higher value than the main agent.
   */
  keep_inline_turns?: number;
  /** P2: hold = no pointerize inside this child until budget pressure. */
  pointerize_mode?: PointerizeMode;
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
  /**
   * SPEC_CONTEXT_POLICY: budget / heavy / protect / prune / token_calibrator knobs.
   * Partial JSON; call normalizeContextPolicy before applying to runtime.
   */
  context_policy?: ContextPolicy;
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
  /**
   * SPEC_SESSION_WORKSPACE: where session files live.
   * project_local = `<cwd>/.sessions` (default); agent_home = `~/.minimal-agent/sessions/by-project/<id>/`
   */
  session_store?: 'project_local' | 'agent_home';
  /** Override agent home (default ~/.minimal-agent or MINIMAL_AGENT_HOME). */
  agent_home?: string;
  /** Capability policy when switching active_cwd (default strict). */
  cwd_switch?: {
    default_capability_policy?: 'strict' | 'inherit_session' | 'inherit_grant_only';
    warn_if_leaving_primary_git_root?: boolean;
  };
  /** SPEC_VISION: multimodal user images */
  vision?: {
    enabled?: boolean;
    max_images_per_message?: number;
    max_bytes_per_image?: number;
    default_detail?: 'auto' | 'low' | 'high';
    allow_remote_url?: boolean;
    materialize_fail?: 'degrade' | 'throw';
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