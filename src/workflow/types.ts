export interface WorkflowRoleConfig {
  prompt_file?: string;
  /** Inline system body when prompt_file omitted. */
  prompt?: string;
  tools?: string[];
  model?: string;
  /** Optional api_profiles key; inherits main agent profile when omitted. */
  api_profile?: string;
  max_turns?: number;
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