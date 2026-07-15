import type { SpawnShellPolicy } from '../plugins/types.js';

export interface WorkflowRoleConfig {
  /**
   * Shared agent profile: `agent.json` spawn_presets[].name or agents/<name>.md
   * (SPEC_WORKFLOW W1). Optional local tools/max_turns/… override the preset.
   */
  preset?: string;
  prompt_file?: string;
  /** Inline system body when prompt_file omitted. */
  prompt?: string;
  tools?: string[];
  model?: string;
  /** Optional api_profiles key; inherits main agent profile when omitted. */
  api_profile?: string;
  max_turns?: number;
  /** Optional shell policy (merged over spawn_policy.shell when preset has shell). */
  shell?: SpawnShellPolicy;
  description?: string;
}

export interface WorkflowStep {
  role: string;
  input: string;
}

export interface WorkflowLoop {
  when: string;
  max_rounds: number;
  steps: WorkflowStep[];
}

export type WorkflowFlowItem = WorkflowStep | { loop: WorkflowLoop };

export interface WorkflowDefinition {
  name: string;
  /** When false, each role only sees its templated input (default). */
  share_session?: boolean;
  roles: Record<string, WorkflowRoleConfig>;
  flow: WorkflowFlowItem[];
}

export interface ResolvedWorkflowRole {
  name: string;
  systemPrompt: string;
  tools: string[];
  model?: string;
  api_profile?: string;
  maxTurns?: number;
  /** Applied via spawnShellPolicy + spawnDepth when role runs. */
  shellPolicy?: import('../plugins/types.js').SpawnShellPolicy;
}

export interface WorkflowRoleResult {
  output: string;
  verdict?: string;
}

export interface WorkflowContext {
  user_task: string;
  roles: Record<string, WorkflowRoleResult>;
}

export type WorkflowHandbackReason =
  | 'loop_guard'
  | 'max_rounds_exhausted'
  | 'turn_ceiling'
  | 'agent_stopped';

export interface WorkflowHandback {
  reason: WorkflowHandbackReason;
  detail: string;
  role?: string;
  round?: number;
  partial_output?: string;
}

export interface WorkflowResult {
  text: string;
  workflow: string;
  context: WorkflowContext;
  sessionId: string;
  /** Set when workflow exits early and returns control to the main agent. */
  handback?: WorkflowHandback;
}