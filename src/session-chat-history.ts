/**
 * Flatten session transcript + in-flight messages for multi-UI chat history.
 * Same data TUI `/transcript` browses via session-history + session-transcript.
 */

import {
  listTranscriptTaskRecords,
  type TranscriptMessage,
} from './session-transcript.js';
import type { ChatMessage, MessageContent, SessionFile } from './types.js';

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
    };
  }
  if (msg.role === 'assistant') {
    return {
      role: 'assistant',
      content: msg.content,
      turn: msg.turn,
      task_id: taskId,
      source: 'transcript',
      completed_at: completedAt,
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
    };
  }
  if (msg.role === 'user') {
    return {
      role: 'user',
      content: contentToText(msg.content),
      turn: msg.turn,
      task_id: taskId,
      source: 'in_flight',
    };
  }
  if (msg.role === 'assistant') {
    return {
      role: 'assistant',
      content: contentToText(msg.content),
      turn: msg.turn,
      task_id: taskId,
      source: 'in_flight',
    };
  }
  if (msg.role === 'tool') {
    return {
      role: 'tool',
      content: contentToText(msg.content),
      turn: msg.turn,
      task_id: taskId,
      tool_name: undefined,
      action_id: msg.action_id ?? msg.tool_call_id,
      source: 'in_flight',
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
