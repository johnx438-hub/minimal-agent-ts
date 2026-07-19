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

/** Tool call attached to an assistant bubble (after coalesce). */
export interface ToolPart {
  toolName: string;
  callId: string;
  content: string;
  status?: "running" | "complete" | "incomplete";
  toolExpanded?: boolean;
  path?: string;
  skin?: "read" | "write" | "shell" | "generic";
}

/** User-message file chip (gui-inbox path); rendered by UserMessageAttachments. */
export interface MessageAttachment {
  id: string;
  name: string;
  /** cwd-relative path under workspace/gui-inbox */
  path: string;
  contentType?: string;
  type?: "image" | "document" | "file";
}

/** GUI-side message (store format, before convertMessage). */
export interface MinimalMessage {
  id: string;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  /**
   * Streaming accumulation (O(1) push). Prefer joinContent() at display time
   * instead of content += delta every token (O(n²) copy).
   */
  contentChunks?: string[];
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
  /** Tools merged into this assistant message (display). */
  toolParts?: ToolPart[];
  /** Assistant bubble that only holds tools — tighter spacing. */
  toolsOnly?: boolean;
  /** User attachments shown as chips (not a separate timeline). */
  attachments?: MessageAttachment[];
}

/** Live sync-spawn / job child activity (not mixed into main bubbles). */
export interface ActiveSpawn {
  id: string;
  preset: string;
  status: "running" | "done" | "failed";
  /** Throttled preview of child stream */
  preview: string;
  lastTool?: string;
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
      workflow_confirm?: WorkflowConfirmPending & {
        type?: "workflow_confirm";
        status?: string;
      } | null;
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
      type: "spawn";
      phase: "start" | "end";
      preset: string;
      ok?: boolean;
      detail?: string;
    }
  | {
      type: "workflow_confirm";
      status: "pending" | "approved" | "denied" | "aborted";
      workflow: string;
      path?: string;
      needs_shell?: boolean;
      needs_web?: boolean;
      roles?: Array<{
        name: string;
        tools: string[];
        needs_shell: boolean;
        needs_web: boolean;
      }>;
      summary?: string;
    }
  | {
      role: "user" | "assistant" | "tool" | "system_notice";
      session_id?: string;
      turn?: number;
      delta?: string;
      content?: string;
      tool_name?: string;
      call_id?: string;
      task_id?: string;
      /** main | spawn | job | workflow | system — child job streams use spawn session_id */
      source?: "main" | "spawn" | "job" | "workflow" | "system";
      source_id?: string;
      type?: undefined;
    };

/** Pending workflow entry checkpoint (TUI overlay parity). */
export interface WorkflowConfirmPending {
  workflow: string;
  path?: string;
  needs_shell?: boolean;
  needs_web?: boolean;
  roles?: Array<{
    name: string;
    tools: string[];
    needs_shell: boolean;
    needs_web: boolean;
  }>;
  summary?: string;
}
