import type { PreviewPolicy } from './action-preview.js';
import type { WorkspaceAgentMd } from './workspace-agent-md.js';
import type { WorkspaceMemoryInjection } from './workspace-memory.js';
import type { AgentStepEvent } from './events.js';
import type { MessageBridge } from './hooks/index.js';
import type { PermissionGate } from './permission-gate.js';
import type { LoopGuardConfig } from './loop-guard.js';
import type {
  AgentPluginConfig,
  CachePolicyConfig,
  LlmWire,
  SpawnPolicy,
  SpawnShellPolicy,
  WebFetchPolicy,
  WebSearchPolicy,
} from './plugins/types.js';

/** Resolved LLM connection for one agent run (轨 G). */
export interface LlmProfile {
  profileName: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  wire: LlmWire;
  cache?: CachePolicyConfig;
  extraBody?: Record<string, unknown>;
  displayName?: string;
  fallbackProfiles?: string[];
  reasoningMap?: Record<string, Record<string, unknown>>;
  /**
   * Re-send assistant reasoning_content on later turns (Kimi Preserved Thinking).
   * Parse/store always; outbound only when true.
   */
  preserveReasoning?: boolean;
  /** Env var that supplied apiKey (diagnostics). */
  apiKeyEnv?: string;
  /** Profile accepts image_url parts (SPEC_VISION); gates read_file image attach. */
  supportsVision?: boolean;
  available: boolean;
  unavailableReason?: string;
}

/** OpenAI-compatible chat message (subset we need for the loop). */
export type Role = 'system' | 'user' | 'assistant' | 'tool';

export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

/** OpenAI-compatible multimodal content parts (SPEC_VISION). */
export type TextContentPart = { type: 'text'; text: string };

export type ImageUrlContentPart = {
  type: 'image_url';
  image_url: {
    url: string;
    detail?: 'auto' | 'low' | 'high';
  };
};

export type ContentPart = TextContentPart | ImageUrlContentPart;

/** string for legacy/tool/assistant; ContentPart[] after materialize for API. */
export type MessageContent = string | ContentPart[] | null;

/** Session-persisted image reference (path preferred over base64). */
export interface VisionRef {
  /** Path relative to cwd or absolute under grants. */
  path?: string;
  mime?: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
  detail?: 'auto' | 'low' | 'high';
  /** Optional https URL when allow_remote_url is enabled. */
  remote_url?: string;
}

export interface ChatMessage {
  role: Role;
  content: MessageContent;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  /**
   * Thinking / CoT from the model (Kimi `reasoning_content`, DeepSeek-style).
   * Stored when present; re-sent only if profile.preserve_reasoning.
   */
  reasoning_content?: string;
  /** Phase 2: linkage to ActionStore (not sent to LLM API). */
  action_id?: string;
  pointerized?: boolean;
  compacted_at?: number;
  turn?: number;
  /**
   * User-message image refs (SPEC_VISION). Stripped before API;
   * materializeVisionMessage turns them into image_url parts.
   */
  vision_refs?: VisionRef[];
}

/** Cold-storage unit for one tool invocation (Phase 2). */
export interface ActionBlock {
  action_id: string;
  task_id: string;
  session_id: string;
  turn_number: number;
  tool_name: string;
  args_json: string;
  result_text: string;
  result_hash: string;
  byte_size: number;
  line_count: number;
  pointerized: boolean;
  files_touched: string[];
  timestamp: number;
  token_cost: number;
  /** Frozen card preview (computed at save time). */
  preview_summary?: string;
  preview_lines?: string[];
  /** Parent session for spawn cold storage under actions/spawn/<parent>/ */
  spawn_parent_session_id?: string;
}

/** Tool definition sent to the API. */
/** Agent.md + memory loaded once per run for prompt and run_start metadata. */
export interface WorkspacePromptBundle {
  agentMd: WorkspaceAgentMd | null;
  memory: WorkspaceMemoryInjection | null;
}

export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface AgentConfig {
  /** @deprecated Prefer `config.llm.apiKey` after `configureAgentLlmBinding()`. */
  apiKey: string;
  /** @deprecated Prefer `config.llm.baseUrl` after `configureAgentLlmBinding()`. */
  baseUrl: string;
  /** @deprecated Prefer `config.llm.model` after `configureAgentLlmBinding()`. */
  model: string;
  /** 0 = unlimited (loop guard + hard ceiling apply). */
  maxTurns: number;
  cwd: string;
  allowShell: boolean;
  allowWeb: boolean;
  webFetchPolicy?: WebFetchPolicy;
  webSearchPolicy?: WebSearchPolicy;
  /** Per-task external web_search count (cache hits do not increment). */
  webSearchTaskState?: { externalCount: number };
  /** Set at runtime for recall_query session scoping. */
  sessionId?: string;
  loopGuard?: LoopGuardConfig;
  /** Recent tool turns kept inline before pointerize. */
  keepInlineTurns?: number;
  /**
   * Full pointerize policy (tool_overrides). When set, materializePriorTurnTools
   * uses per-tool keep/mode (SPEC_POINTERIZE_SCOPE).
   */
  pointerizePolicy?: import('./plugins/types.js').PointerizePolicy;
  /** recall_query auto format=full when action_id hit and body is below this size. */
  recallAutoFullMaxChars?: number;
  previewPolicy?: PreviewPolicy;
  /** When set, only these builtin/MCP tool names are exposed to the API. */
  toolAllowlist?: string[];
  /**
   * Path grants for multi-root tools (SPEC_SESSION_WORKSPACE).
   * When set, readable/writable resolution consults these in addition to cwd.
   */
  workspaceGrants?: import('./workspace.js').WorkspaceGrant[];
  /** When aborted, LLM fetch and long-running tools should stop. */
  abortSignal?: AbortSignal;
  /** Nested spawn_agent depth (0 = main agent). */
  spawnDepth?: number;
  /** Forward sub-agent step events to parent (spawn tool). */
  nestedStepSink?: (event: AgentStepEvent) => void;
  /**
   * Optional MessageBridge (L3). Spawn/job paths tag source=spawn|job.
   * Prefer RuntimeEvent-only nestedStepSink so main bridge is not double-fed.
   */
  messageBridge?: MessageBridge;
  /** JIT shell/web approval (TUI); unset in headless unless wired. */
  permissionGate?: PermissionGate;
  /** Spawn concurrency and turn limits from agent.json spawn_policy. */
  spawnPolicy?: SpawnPolicy;
  /**
   * C5: effective shell policy for this agent run (set on spawn children).
   * Enforced only when spawnDepth > 0 inside run_shell.
   */
  spawnShellPolicy?: SpawnShellPolicy;
  /** Spawn lifecycle hooks for TUI / --json-events (main agent only). */
  spawnLifecycle?: (event: SpawnLifecycleEvent) => void;
  /** Parent session id when running as a spawn sub-agent (cold storage path). */
  spawnParentSessionId?: string;
  /** Pre-loaded Agent.md + memory so run_start metadata matches the system prompt. */
  workspacePrompt?: WorkspacePromptBundle;
  /** Resolved api profile binding (轨 G); mirrors apiKey/baseUrl/model when set. */
  llm?: LlmProfile;
  /** Full profile fallback chain for this run (G3); primary first. */
  llmBindingChain?: import('./llm-profiles.js').ResolvedLlmBinding[];
  /** When false, only the effective profile is used (explicit model or FALLBACK=0). */
  llmProfileFallbackEnabled?: boolean;
  /** Set when profile-chain fallback is disabled (surfaced on run_start.llm). */
  llmProfileFallbackDisabledReason?: 'FALLBACK=0' | 'explicit_model';
  /** Session /reasoning level key into profile reasoning_map (G4); main agent only. */
  sessionReasoningLevel?: string;
  /** agent.json snapshot for spawn/workflow per-preset LLM resolution. */
  llmPluginConfig?: AgentPluginConfig;
  /**
   * Set only for workflow role steps (SPEC_WORKFLOW W4).
   * Enables workflow_handoff tool; never set on main-agent runs.
   */
  workflowRole?: import('./workflow/handoff-tool.js').WorkflowRoleRuntime;
}

export type SpawnLifecycleEvent =
  | { phase: 'start'; preset: string }
  | { phase: 'end'; preset: string; ok: boolean; detail?: string };

/** recall_query response shape (Phase 2b). */
export interface RecallResult {
  action_id: string;
  tool_name: string;
  matched: boolean;
  content: string;
  total_chars: number;
  has_more: boolean;
  stale?: boolean;
  hint?: string;
}

/** Task summary with hybrid fields (auto-extract + Agent supplement). */
export interface TaskSummaryDoc {
  task_id: string;
  session_id: string;
  
  turn_range: [number, number];
  action_count: number;
  
  // Auto-extracted fields (zero LLM cost)
  user_intent: string;           // First user message
  user_messages: string[];       // All role=user messages
  files_touched: string[];       // From tool_calls.args.path
  tech_concepts: string[];       // Inferred from file extensions
  tools_used: string[];          // From tool_calls.name
  
  // Agent-supplemented fields (~50 tokens)
  pending_tasks: string[];    // Explicitly asked but not completed
  current_work: string;       // What was worked on immediately before summary
}

/** Per-session LLM overrides from /profile /model /reasoning (main agent only). */
export interface SessionLlmOverride {
  profileName?: string;
  model?: string;
  /** Key into effective profile reasoning_map (G4 /reasoning). */
  reasoningLevel?: string;
}

/** One successful mid-session invoke_skill (for compression notice + recall). */
export interface SessionSkillInvoked {
  name: string;
  action_id?: string;
  query?: string;
  turn?: number;
  /** Unix ms when last loaded / refreshed. */
  at: number;
}

/** Session state persisted to session.json. */
export interface SessionFile {
  session_id: string;
  user_id: string;
  created_at: number;          // Unix timestamp (ms)
  /** Last persist / activity; used for resume-last ordering. */
  updated_at?: number;
  tasks: TaskSummaryDoc[];     // Completed task summaries
  current_messages: ChatMessage[];  // Messages for ongoing task
  /** Restored on resume / restart so slash overrides survive process exit. */
  llm_override?: SessionLlmOverride;
  /**
   * Optional human note for /sessions picker (max ~80 chars when set via TUI).
   * Empty / missing = no note.
   */
  note?: string;
  /**
   * Skills loaded via invoke_skill this session (not agent.json loaded_skills).
   * Upsert by name; used in compression notice for recall pointers.
   */
  skills_invoked?: SessionSkillInvoked[];
  /**
   * SPEC_SESSION_WORKSPACE: project bucket + active_cwd + path grants.
   * Optional for legacy session files.
   */
  workspace?: import('./workspace.js').SessionWorkspaceState;
}

/** Session metadata for quick lookup. */
export interface SessionMeta {
  session_id: string;
  user_id: string;
  created_at: number;
  updated_at?: number;
  task_count: number;
  path: string;                // File path to session.json
  /** Last user message preview for session pickers. */
  last_user_preview?: string;
  /** Latest completed task user_intent preview. */
  last_task_intent?: string;
  /**
   * Best one-line task summary for the list (current_work → intent → user msg).
   * Prefer this over raw last_user_preview for the right-hand column.
   */
  last_task_summary?: string;
  /** Up to 2 paths from the latest completed task. */
  last_files_touched?: string[];
  /** User-authored session note (from SessionFile.note). */
  note?: string;
  /** Whether current_messages has in-flight context. */
  has_in_flight?: boolean;
}

/** Read-only session summary for TUI detail overlay. */
export interface SessionOverview {
  session_id: string;
  created_at: number;
  updated_at?: number;
  task_count: number;
  in_flight_preview: string;
  has_in_flight: boolean;
  note?: string;
  tasks: Array<{
    task_id: string;
    user_intent: string;
    turn_range: [number, number];
    files_touched: string[];
  }>;
}