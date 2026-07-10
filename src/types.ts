import type { PreviewPolicy } from './action-preview.js';
import type { WorkspaceAgentMd } from './workspace-agent-md.js';
import type { WorkspaceMemoryInjection } from './workspace-memory.js';
import type { AgentStepEvent } from './events.js';
import type { PermissionGate } from './permission-gate.js';
import type { LoopGuardConfig } from './loop-guard.js';
import type {
  AgentPluginConfig,
  CachePolicyConfig,
  LlmWire,
  SpawnPolicy,
  WebFetchPolicy,
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

export interface ChatMessage {
  role: Role;
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  /** Phase 2: linkage to ActionStore (not sent to LLM API). */
  action_id?: string;
  pointerized?: boolean;
  compacted_at?: number;
  turn?: number;
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
  apiKey: string;
  baseUrl: string;
  model: string;
  /** 0 = unlimited (loop guard + hard ceiling apply). */
  maxTurns: number;
  cwd: string;
  allowShell: boolean;
  allowWeb: boolean;
  webFetchPolicy?: WebFetchPolicy;
  /** Set at runtime for recall_query session scoping. */
  sessionId?: string;
  loopGuard?: LoopGuardConfig;
  /** Recent tool turns kept inline before pointerize. */
  keepInlineTurns?: number;
  /** recall_query auto format=full when action_id hit and body is below this size. */
  recallAutoFullMaxChars?: number;
  previewPolicy?: PreviewPolicy;
  /** When set, only these builtin/MCP tool names are exposed to the API. */
  toolAllowlist?: string[];
  /** When aborted, LLM fetch and long-running tools should stop. */
  abortSignal?: AbortSignal;
  /** Nested spawn_agent depth (0 = main agent). */
  spawnDepth?: number;
  /** Forward sub-agent step events to parent (spawn tool). */
  nestedStepSink?: (event: AgentStepEvent) => void;
  /** JIT shell/web approval (TUI); unset in headless unless wired. */
  permissionGate?: PermissionGate;
  /** Spawn concurrency and turn limits from agent.json spawn_policy. */
  spawnPolicy?: SpawnPolicy;
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
  /** agent.json snapshot for spawn/workflow per-preset LLM resolution. */
  llmPluginConfig?: AgentPluginConfig;
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

/** Session state persisted to session.json. */
export interface SessionFile {
  session_id: string;
  user_id: string;
  created_at: number;          // Unix timestamp (ms)
  /** Last persist / activity; used for resume-last ordering. */
  updated_at?: number;
  tasks: TaskSummaryDoc[];     // Completed task summaries
  current_messages: ChatMessage[];  // Messages for ongoing task
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
  tasks: Array<{
    task_id: string;
    user_intent: string;
    turn_range: [number, number];
    files_touched: string[];
  }>;
}