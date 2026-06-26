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
}

/** Tool definition sent to the API. */
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
  maxTurns: number;
  cwd: string;
  allowShell: boolean;
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
  tasks: TaskSummaryDoc[];     // Completed task summaries
  current_messages: ChatMessage[];  // Messages for ongoing task
}

/** Session metadata for quick lookup. */
export interface SessionMeta {
  session_id: string;
  user_id: string;
  created_at: number;
  task_count: number;
  path: string;                // File path to session.json
}