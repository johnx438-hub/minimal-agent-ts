import type { LlmCacheStats } from './llm-cache.js';

export type ToolPlanReason =
  | 'parallel_safe'
  | 'serial_only_tool'
  | 'not_parallel_safe'
  | 'conflicts_pending_write'
  | 'conflicts_shell_on_path';

export interface ToolPlanEntry {
  id: string;
  name: string;
  args_preview: string;
  disposition: 'parallel' | 'serial';
  reason: ToolPlanReason;
  detail?: string;
}

/** Per-turn agent loop events (headless / TUI / --json-events). */
export type AgentStepEvent =
  | { type: 'turn_start'; turn: number }
  | { type: 'token'; turn: number; delta: string }
  | {
      type: 'llm_done';
      turn: number;
      finishReason: string | null;
      usage?: Record<string, unknown>;
      cache?: LlmCacheStats;
    }
  | {
      type: 'llm_retry';
      turn: number;
      attempt: number;
      max_attempts: number;
      reason: string;
      delay_ms: number;
    }
  | {
      type: 'llm_fallback';
      turn: number;
      from_profile: string;
      to_profile: string;
      from_model: string;
      to_model: string;
      reason: string;
      /** HTTP retries exhausted on from_profile before switching (not fallback hop index). */
      http_retries_exhausted: number;
    }
  | {
      type: 'tool_plan';
      turn: number;
      total: number;
      parallel_count: number;
      serial_count: number;
      entries: ToolPlanEntry[];
    }
  | { type: 'tool_batch'; turn: number; total: number; parallel: number }
  | { type: 'tool_args_invalid'; turn: number; count: number }
  | { type: 'tool_call'; turn: number; call_id: string; name: string; args: string }
  | {
      type: 'tool_result';
      turn: number;
      call_id: string;
      name: string;
      args: string;
      output: string;
      preview?: string;
      /** Rich TUI payload (e.g. write_file diff); not stored in agent messages. */
      display?: string;
    }
  | {
      type: 'compression';
      turn: number;
      pointerized: number;
      pruned: number;
      pointer_compacted: number;
      heavy_compression: boolean;
    }
  | { type: 'draft_discarded'; turn: number; chars: number }
  | {
      type: 'loop_guard';
      turn: number;
      action: 'soft_nudge' | 'forced_summary' | 'terminate';
      reason?: string;
    }
  | { type: 'final'; turn: number; text: string }
  | {
      type: 'turn_io';
      turn: number;
      actions_saved: number;
      action_save_ms: number;
      queue_depth: number;
    };

/** LLM binding snapshot on run_start (轨 G2-a); no secrets. */
export interface RunStartLlmMeta {
  profile: string;
  model: string;
  cache_mode?: string;
  base_url_host?: string;
  /** Session /reasoning level (G4). */
  reasoning?: string;
  /** True when TUI session override is active (G2-c). */
  session_override?: boolean;
  /** False when FALLBACK=0 or explicit model disables profile chain (G3). */
  profile_fallback_enabled?: boolean;
  profile_fallback_disabled_reason?: 'FALLBACK=0' | 'explicit_model';
}

/** Agent step events plus runtime lifecycle events (TUI / --json-events). */
export type RuntimeEvent =
  | AgentStepEvent
  | {
      type: 'run_start';
      session_id: string;
      cwd: string;
      agent_md?: { path: string; chars: number; truncated: boolean };
      memory?: {
        profile_chars: number;
        requirements_chars: number;
        truncated: boolean;
      };
      llm?: RunStartLlmMeta;
    }
  | { type: 'run_stopping'; session_id: string }
  | { type: 'run_end'; reason: 'completed' | 'aborted' | 'error'; message?: string }
  | { type: 'session_saved'; session_id: string; task_count: number }
  | { type: 'runtime'; shell: boolean; web: boolean }
  | {
      type: 'workflow_confirm_start';
      workflow: string;
      path: string;
      needs_shell: boolean;
      needs_web: boolean;
      roles: Array<{
        name: string;
        tools: string[];
        needs_shell: boolean;
        needs_web: boolean;
      }>;
    }
  | {
      type: 'workflow_confirm_end';
      workflow: string;
      approved: boolean;
      reason: 'approved' | 'denied' | 'aborted';
    }
  | {
      type: 'permission_prompt_start';
      kind: 'shell' | 'web' | 'path_escape';
      reason: string;
    }
  | {
      type: 'permission_prompt_end';
      kind: 'shell' | 'web' | 'path_escape';
      approved: boolean;
      reason: 'approved' | 'denied' | 'aborted';
    }
  | {
      type: 'workflow_step';
      phase: 'role' | 'loop' | 'parallel' | 'switch' | 'dag' | 'job';
      role: string;
      round?: number;
      /** DAG node id when available (Web UI / multi-UI). */
      nodeId?: string;
      /** Context slot alias when available. */
      as?: string;
    }
  | {
      type: 'workflow_handback';
      workflow: string;
      reason:
        | 'loop_guard'
        | 'max_rounds_exhausted'
        | 'turn_ceiling'
        | 'agent_stopped'
        | 'dag_exhausted'
        | 'needs_human';
      detail: string;
      role?: string;
      round?: number;
    }
  | { type: 'spawn_start'; preset: string }
  | { type: 'spawn_end'; preset: string; ok: boolean; detail?: string }
  /** One-shot /skills load list changed (Web UI chips). loaded = sticky ∪ remaining armed. */
  | { type: 'skills'; loaded: string[] }
  | { type: 'action_flush'; flush_ms: number; count: number; pending: number }
  | {
      type: 'job_list';
      jobs: Array<{
        job_id: string;
        status: string;
        preset: string;
        llm_tag: string;
        task_preview: string;
        stale: boolean;
      }>;
      running_count: number;
    }
  | {
      type: 'job_status';
      job_id: string;
      status: string;
      preset: string;
      stale: boolean;
      event_count: number;
      has_result: boolean;
    }
  | {
      /** SPEC_JOB_SESSION_NOTIFY: job/workflow settle push */
      type: 'system_event';
      kind: import('./hooks/system-event.js').SystemEventKind | string;
      session_id: string;
      event_id: string;
      job_id?: string;
      workflow?: string;
      still_running?: number;
      summary?: string;
    };

export function formatRunStartLlmSummary(llm: RunStartLlmMeta): string {
  const parts = [`${llm.profile}/${llm.model}`];
  if (llm.cache_mode && llm.cache_mode !== 'off') {
    parts.push(`cache=${llm.cache_mode}`);
  }
  if (llm.base_url_host) {
    parts.push(`host=${llm.base_url_host}`);
  }
  if (llm.reasoning) {
    parts.push(`reasoning=${llm.reasoning}`);
  }
  if (llm.session_override) {
    parts.push('(override)');
  }
  if (llm.profile_fallback_enabled === false) {
    const reason = llm.profile_fallback_disabled_reason ?? 'disabled';
    parts.push(`fallback=off(${reason})`);
  }
  return parts.join(' ');
}

export function formatLlmRetrySummary(event: {
  attempt: number;
  max_attempts: number;
  reason: string;
  delay_ms: number;
}): string {
  const delaySec = (event.delay_ms / 1000).toFixed(1).replace(/\.0$/, '');
  return `↻ LLM retry ${event.attempt}/${event.max_attempts} (${event.reason}, ${delaySec}s)`;
}

export function formatLlmFallbackSummary(event: {
  from_profile: string;
  to_profile: string;
  from_model: string;
  to_model: string;
  reason: string;
}): string {
  return `⇢ LLM fallback ${event.from_profile}/${event.from_model} → ${event.to_profile}/${event.to_model} (${event.reason})`;
}

export type CompressionStepEvent = Extract<AgentStepEvent, { type: 'compression' }>;

export function formatCompressionSummary(event: CompressionStepEvent): string {
  const parts: string[] = [];
  if (event.pointerized > 0) {
    parts.push(`pointerized ${event.pointerized}`);
  }
  if (event.pruned > 0) {
    parts.push(`pruned ${event.pruned}`);
  }
  if (event.pointer_compacted > 0) {
    parts.push(`compacted ${event.pointer_compacted} pointer cards`);
  }
  if (event.heavy_compression) {
    parts.push('summaries + notice + replay');
  }
  return parts.length > 0 ? `📦 ${parts.join(', ')}` : '📦 compression';
}

export function formatToolPlanSummary(event: {
  total: number;
  parallel_count: number;
  serial_count: number;
}): string {
  return `plan: ${event.total} tools — parallel ${event.parallel_count}, serial ${event.serial_count}`;
}

export function isAbortError(err: unknown): boolean {
  return (
    (err instanceof DOMException && err.name === 'AbortError') ||
    (err instanceof Error && err.name === 'AbortError')
  );
}

/** One NDJSON line envelope for --json-events consumers. */
export interface JsonEventEnvelope {
  ts: number;
  event: RuntimeEvent;
}

/** Stable tool_result shape on the JSON stream (display is UI-only in agent messages). */
export type ToolResultJsonEvent = Extract<AgentStepEvent, { type: 'tool_result' }>;

function isToolResultEvent(event: RuntimeEvent): event is ToolResultJsonEvent {
  return event.type === 'tool_result';
}

/**
 * Normalize events before JSON serialization.
 * tool_result: always emit call_id/args/output; include display only when present.
 */
export function normalizeRuntimeEventForJson(event: RuntimeEvent): RuntimeEvent {
  if (!isToolResultEvent(event)) return event;

  const normalized: ToolResultJsonEvent = {
    type: 'tool_result',
    turn: event.turn,
    call_id: event.call_id,
    name: event.name,
    args: event.args,
    output: event.output,
  };

  if (event.preview !== undefined) {
    normalized.preview = event.preview;
  }
  if (event.display !== undefined && event.display.length > 0) {
    normalized.display = event.display;
  }

  return normalized;
}

export function buildJsonEventEnvelope(
  event: RuntimeEvent,
  ts: number = Date.now(),
): JsonEventEnvelope {
  return { ts, event: normalizeRuntimeEventForJson(event) };
}

/** Serialize one runtime event as a single NDJSON line. */
export function serializeRuntimeEvent(event: RuntimeEvent, ts?: number): string {
  return JSON.stringify(buildJsonEventEnvelope(event, ts));
}

/** Parse one NDJSON line emitted by serializeRuntimeEvent / emitJsonEvent. */
export function parseJsonEventLine(line: string): JsonEventEnvelope {
  const parsed = JSON.parse(line) as JsonEventEnvelope;
  if (!parsed || typeof parsed.ts !== 'number' || !parsed.event || typeof parsed.event !== 'object') {
    throw new Error('invalid json event line');
  }
  return parsed;
}

export function emitJsonEvent(event: RuntimeEvent): void {
  process.stdout.write(`${serializeRuntimeEvent(event)}\n`);
}