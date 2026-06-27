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

export interface PointerizePolicy {
  /** Recent tool turns kept inline (not pointerized). Default 2. */
  keep_inline_turns?: number;
}

export interface RecallPolicy {
  /** When recall has action_id and body is smaller, default format=full. Default 24000. */
  auto_full_max_chars?: number;
}

export interface AgentPluginConfig {
  builtin_tools?: string[];
  mcp_servers?: McpServerConfig[];
  skills_dirs?: string[];
  mcp_policy?: McpPolicy;
  pointerize_policy?: PointerizePolicy;
  recall_policy?: RecallPolicy;
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