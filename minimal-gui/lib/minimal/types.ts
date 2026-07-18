/** Align with minimal-agent-ts docs/WEB_UI_API.md */

export type ConnectionState =
  | "idle"
  | "connecting"
  | "open"
  | "closed"
  | "error";

export type RunState = "idle" | "running" | "aborted" | "error";

export type ViewKind =
  | "chat"
  | "tool"
  | "task_summary"
  | "artifact"
  | "system_ui";

export interface MessageMeta {
  pending_tasks?: string[];
  current_work?: string;
  artifact?: boolean;
}

/** GUI-side message (store format, before convertMessage). */
export interface MinimalMessage {
  id: string;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  /** streaming | complete */
  status?: "running" | "complete" | "incomplete";
  toolName?: string;
  callId?: string;
  turn?: number;
  taskId?: string;
  source?: "transcript" | "in_flight" | "live";
  meta?: MessageMeta;
  viewKind?: ViewKind;
  /**
   * Tool UI: expand by default when generating or in latest user turn.
   * Older tools stay collapsed.
   */
  toolExpanded?: boolean;
}

export interface SessionMeta {
  session_id: string;
  updated_at?: number;
  task_count?: number;
  note?: string;
}

export interface WorkflowMeta {
  name: string;
  path?: string;
  kind?: string;
  roles?: string[];
}

export interface SkillMeta {
  name: string;
  description?: string;
}

export interface ProfileMeta {
  name: string;
  displayName?: string;
  available?: boolean;
  active?: boolean;
}

export interface ModelMeta {
  model: string;
  active?: boolean;
}

export interface JobMeta {
  id: string;
  status: string;
  label?: string;
}

/** History row from GET /v1/messages */
export interface SessionChatMessageDto {
  role: "user" | "assistant" | "tool" | "system";
  content: string;
  turn?: number;
  task_id?: string;
  tool_name?: string;
  action_id?: string;
  source?: "transcript" | "in_flight";
  meta?: MessageMeta;
  view_kind?: ViewKind;
}

export type WsFrame =
  | {
      type: "hello";
      session_id?: string;
      model?: string;
      profile?: string;
      running?: boolean;
      sessions?: SessionMeta[];
      jobs?: Array<{ id: string; status: string; label?: string }>;
      armed_workflow?: string | null;
      loaded_skills?: string[];
    }
  | {
      type: "run_state";
      state: RunState;
      detail?: string;
      session_id?: string;
      model?: string;
    }
  | { type: "job"; id: string; status: string; label?: string }
  | {
      type: "workflow_step";
      phase: string;
      role: string;
      nodeId?: string;
      as?: string;
      round?: number;
      status?: string;
    }
  | {
      type: "workflow_handback";
      workflow: string;
      reason: string;
      detail: string;
    }
  | { type: "workflow_armed"; path: string | null; name?: string | null }
  | {
      type: "llm";
      profile?: string | null;
      model?: string | null;
      armed_workflow?: string | null;
    }
  | { type: "skills"; loaded: string[] }
  | {
      role: "user" | "assistant" | "tool" | "system_notice";
      session_id?: string;
      turn?: number;
      delta?: string;
      content?: string;
      tool_name?: string;
      call_id?: string;
      task_id?: string;
      type?: undefined;
    };
