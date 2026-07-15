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

/** Structured when (W2); string form kept for compatibility. */
export interface WorkflowWhenClause {
  path: string;
  eq: string;
}

export type WorkflowWhen = string | WorkflowWhenClause;

export type WorkflowRunMode = 'agent' | 'job';

export interface WorkflowStep {
  role: string;
  input: string;
  id?: string;
  /**
   * Context slot name for this step's output (default = role).
   * Required to distinguish parallel steps that share the same role.
   */
  as?: string;
  /**
   * agent (default) — blocking runAgent.
   * job — spawn_background + await result (SPEC_WORKFLOW W3).
   */
  mode?: WorkflowRunMode;
}

export interface WorkflowLoop {
  when: WorkflowWhen;
  max_rounds: number;
  steps: WorkflowStep[];
}

export interface WorkflowParallel {
  steps: WorkflowStep[];
  /** Reserved; only 'all' supported (Promise.all). */
  join?: 'all';
}

export interface WorkflowSwitch {
  /** Template path, e.g. reviewer.verdict or {{reviewer.verdict}} */
  on: string;
  /** Branch key → nested flow items */
  cases: Record<string, WorkflowFlowItem[]>;
  default?: WorkflowFlowItem[];
}

export type WorkflowFlowItem =
  | WorkflowStep
  | { loop: WorkflowLoop }
  | { parallel: WorkflowParallel }
  | { switch: WorkflowSwitch };

/** DAG node (W3). Output always stored under node id; optional `as` alias. */
export interface WorkflowNode {
  role: string;
  input: string;
  as?: string;
  mode?: WorkflowRunMode;
  /** Cap how many times this node may run (default 1; raise for loop-backs). */
  max_visits?: number;
}

export interface WorkflowEdge {
  from: string;
  to: string;
  /** If set, edge only activates when condition is true after `from` completes. */
  when?: WorkflowWhen;
  /** Cap activations of this edge (default unlimited). */
  max_visits?: number;
}

export interface WorkflowDefinition {
  name: string;
  /** When false, each role only sees its templated input (default). */
  share_session?: boolean;
  roles: Record<string, WorkflowRoleConfig>;
  /**
   * Linear / structured flow (W1–W2). Mutually exclusive with nodes+edges+entry.
   */
  flow?: WorkflowFlowItem[];
  /**
   * DAG mode (W3). Requires `entry` + `edges`. Mutually exclusive with `flow`.
   */
  nodes?: Record<string, WorkflowNode>;
  edges?: WorkflowEdge[];
  /** DAG entry node id. */
  entry?: string;
}

export interface ResolvedWorkflowRole {
  name: string;
  systemPrompt: string;
  tools: string[];
  model?: string;
  api_profile?: string;
  maxTurns?: number;
  /** Applied via spawnShellPolicy + spawnDepth when role runs. */
  shellPolicy?: SpawnShellPolicy;
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
  | 'agent_stopped'
  /** DAG scheduler hit maxIterations or stuck with unfinished nodes. */
  | 'dag_exhausted';

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

export type WorkflowStepPhase =
  | 'role'
  | 'loop'
  | 'parallel'
  | 'switch'
  | 'dag'
  | 'job';
