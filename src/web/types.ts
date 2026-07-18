/** Control frames on WebSocket (in addition to SessionMessage). */

export type WebRunState = 'idle' | 'running' | 'aborted' | 'error';

export interface WebHelloFrame {
  type: 'hello';
  session_id?: string;
  model?: string;
  running: boolean;
  profile?: string;
  armed_workflow?: string | null;
  loaded_skills?: string[];
  /** Recent sessions for sidebar bootstrap (W2). */
  sessions?: Array<{
    session_id: string;
    updated_at?: number;
    task_count?: number;
    note?: string;
  }>;
  jobs?: WebJobFrame[];
}

export interface WebRunStateFrame {
  type: 'run_state';
  state: WebRunState;
  detail?: string;
  session_id?: string;
  model?: string;
}

export interface WebJobFrame {
  type: 'job';
  id: string;
  status: string;
  label?: string;
  stale?: boolean;
  llm_tag?: string;
}

export interface WebWorkflowStepFrame {
  type: 'workflow_step';
  phase: string;
  role: string;
  round?: number;
  nodeId?: string;
  as?: string;
  /** running when emitted at step start */
  status?: 'running' | 'done';
}

export interface WebWorkflowHandbackFrame {
  type: 'workflow_handback';
  workflow: string;
  reason: string;
  detail: string;
  role?: string;
  round?: number;
}

export interface WebLlmFrame {
  type: 'llm';
  profile?: string | null;
  profile_display?: string | null;
  model?: string | null;
  armed_workflow?: string | null;
  loaded_skills?: string[];
}

export interface WebWorkflowArmedFrame {
  type: 'workflow_armed';
  path: string | null;
  name?: string | null;
}

export interface WebSkillsFrame {
  type: 'skills';
  loaded: string[];
}

export type WebControlFrame =
  | WebHelloFrame
  | WebRunStateFrame
  | WebJobFrame
  | WebWorkflowStepFrame
  | WebWorkflowHandbackFrame
  | WebLlmFrame
  | WebWorkflowArmedFrame
  | WebSkillsFrame;

export interface WebUiServerOptions {
  /** Default 127.0.0.1 — never bind public without explicit opt-in later. */
  host?: string;
  port?: number;
  token?: string;
  /** Directory containing index.html for the browser UI. */
  uiDir?: string;
  /** Serve cwd/workspace under /workspace (readonly). Default true. */
  serveWorkspace?: boolean;
}

export interface WebUiHandle {
  host: string;
  port: number;
  token: string;
  url: string;
  close: () => Promise<void>;
}
