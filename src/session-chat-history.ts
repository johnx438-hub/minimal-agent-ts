/**
 * Flatten session transcript + in-flight messages for multi-UI chat history.
 * Same data TUI `/transcript` browses via session-history + session-transcript.
 *
 * Projection (display): strip pending_tasks JSON tail; expose meta for UI cards.
 */

import {
  listTranscriptTaskRecords,
  type TranscriptMessage,
} from './session-transcript.js';
import { extractCleanAnswer, parseAgentSummary } from './summary.js';
import type { ChatMessage, MessageContent, SessionFile } from './types.js';

export interface SessionChatMessageMeta {
  pending_tasks?: string[];
  current_work?: string;
  /** Pointer / compacted placeholder (not full tool body). */
  artifact?: boolean;
}

export interface SessionChatMessage {
  role: 'user' | 'assistant' | 'tool' | 'system';
  content: string;
  turn?: number;
  task_id?: string;
  tool_name?: string;
  action_id?: string;
  /** transcript completed task | live current_messages */
  source: 'transcript' | 'in_flight';
  completed_at?: number;
  meta?: SessionChatMessageMeta;
  /**
   * chat = main timeline; tool = collapsible; task_summary reserved;
   * artifact = compacted/pointer stub.
   */
  view_kind?: 'chat' | 'tool' | 'task_summary' | 'artifact' | 'system_ui';
}

function contentToText(content: MessageContent): string {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => (p.type === 'text' ? p.text : `[image:${p.image_url?.url?.slice(0, 48) ?? ''}]`))
      .join('\n');
  }
  return String(content);
}

function looksLikeArtifact(content: string): boolean {
  const t = content.trim();
  if (!t) return false;
  if (t.startsWith('[action:')) return true;
  if (t.includes('…[truncated]') || t.includes('...[truncated]')) return true;
  if (/^\[pointer/i.test(t)) return true;
  return false;
}

function projectAssistantBody(raw: string): {
  content: string;
  meta?: SessionChatMessageMeta;
  view_kind: SessionChatMessage['view_kind'];
} {
  const summary = parseAgentSummary(raw);
  const clean = extractCleanAnswer(raw);
  const hasMeta =
    summary.pending_tasks.length > 0 || Boolean(summary.current_work?.trim());
  if (looksLikeArtifact(clean)) {
    return {
      content: clean,
      view_kind: 'artifact',
      meta: { artifact: true },
    };
  }
  return {
    content: clean,
    view_kind: 'chat',
    meta: hasMeta
      ? {
          pending_tasks: summary.pending_tasks,
          current_work: summary.current_work || undefined,
        }
      : undefined,
  };
}

function fromTranscriptMessage(
  msg: TranscriptMessage,
  taskId: string,
  completedAt: number,
): SessionChatMessage {
  if (msg.role === 'user') {
    return {
      role: 'user',
      content: msg.content,
      turn: msg.turn,
      task_id: taskId,
      source: 'transcript',
      completed_at: completedAt,
      view_kind: 'chat',
    };
  }
  if (msg.role === 'assistant') {
    const projected = projectAssistantBody(msg.content);
    return {
      role: 'assistant',
      content: projected.content,
      turn: msg.turn,
      task_id: taskId,
      source: 'transcript',
      completed_at: completedAt,
      meta: projected.meta,
      view_kind: projected.view_kind,
    };
  }
  return {
    role: 'tool',
    content: msg.preview,
    turn: msg.turn,
    task_id: taskId,
    tool_name: msg.tool_name,
    action_id: msg.action_id,
    source: 'transcript',
    completed_at: completedAt,
    view_kind: 'tool',
  };
}

function fromChatMessage(msg: ChatMessage, taskId?: string): SessionChatMessage | null {
  if (msg.role === 'system') {
    return {
      role: 'system',
      content: contentToText(msg.content),
      turn: msg.turn,
      task_id: taskId,
      source: 'in_flight',
      view_kind: 'system_ui',
    };
  }
  if (msg.role === 'user') {
    return {
      role: 'user',
      content: contentToText(msg.content),
      turn: msg.turn,
      task_id: taskId,
      source: 'in_flight',
      view_kind: 'chat',
    };
  }
  if (msg.role === 'assistant') {
    const raw = contentToText(msg.content);
    const projected = projectAssistantBody(raw);
    return {
      role: 'assistant',
      content: projected.content,
      turn: msg.turn,
      task_id: taskId,
      source: 'in_flight',
      meta: projected.meta,
      view_kind: projected.view_kind,
    };
  }
  if (msg.role === 'tool') {
    const content = contentToText(msg.content);
    return {
      role: 'tool',
      content,
      turn: msg.turn,
      task_id: taskId,
      tool_name: undefined,
      action_id: msg.action_id ?? msg.tool_call_id,
      source: 'in_flight',
      view_kind: looksLikeArtifact(content) ? 'artifact' : 'tool',
      meta: looksLikeArtifact(content) ? { artifact: true } : undefined,
    };
  }
  return null;
}

export interface BuildSessionChatHistoryOptions {
  /** Max messages to return (newest tail if exceeded). Default 500. */
  limit?: number;
  /** Include tool stubs from transcript (default true). */
  includeTools?: boolean;
  /** Include system messages from in-flight (default false). */
  includeSystem?: boolean;
}

/**
 * Chronological chat history: completed transcript tasks (by completed_at)
 * then live `current_messages`.
 */
export function buildSessionChatHistory(
  session: SessionFile,
  opts?: BuildSessionChatHistoryOptions,
): SessionChatMessage[] {
  const limit = Math.max(1, opts?.limit ?? 500);
  const includeTools = opts?.includeTools !== false;
  const includeSystem = opts?.includeSystem === true;
  const out: SessionChatMessage[] = [];

  const records = listTranscriptTaskRecords(session.session_id).slice().sort((a, b) => {
    return (a.completed_at ?? 0) - (b.completed_at ?? 0);
  });

  for (const rec of records) {
    for (const msg of rec.messages) {
      if (!includeTools && msg.role === 'tool') continue;
      out.push(fromTranscriptMessage(msg, rec.task_id, rec.completed_at));
    }
  }

  for (const msg of session.current_messages) {
    if (!includeSystem && msg.role === 'system') continue;
    if (!includeTools && msg.role === 'tool') continue;
    const row = fromChatMessage(msg);
    if (row) out.push(row);
  }

  if (out.length <= limit) return out;
  return out.slice(out.length - limit);
}
