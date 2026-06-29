export interface WorkflowRoleConfig {
  prompt_file?: string;
  /** Inline system body when prompt_file omitted. */
  prompt?: string;
  tools?: string[];
  model?: string;
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

export interface WorkflowResult {
  text: string;
  workflow: string;
  context: WorkflowContext;
  sessionId: string;
}