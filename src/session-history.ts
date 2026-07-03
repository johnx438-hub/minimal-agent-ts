import { LOG_IN_FLIGHT_TASK_ID } from './session-log.js';
import { extractCleanAnswer } from './summary.js';
import {
  listTranscriptTaskRecords,
  readTranscriptTask,
  type TranscriptMessage,
} from './session-transcript.js';
import type { SessionFile, TaskSummaryDoc } from './types.js';

export { LOG_IN_FLIGHT_TASK_ID as HISTORY_IN_FLIGHT_TASK_ID };

export interface HistoryTaskEntry {
  taskId: string;
  label: string;
  description: string;
  kind: 'completed' | 'in_flight';
}

export interface HistoryLineEntry {
  value: string;
  label: string;
  description: string;
  kind: 'user' | 'assistant' | 'tool' | 'section';
  actionId?: string;
  /** Full message body for detail overlay. */
  body?: string;
}

function clip(text: string, max = 72): string {
  const one = text.replace(/\s+/g, ' ').trim();
  if (!one) return '(empty)';
  if (one.length <= max) return one;
  return `${one.slice(0, max - 1)}…`;
}

export function listHistoryTasks(session: SessionFile): HistoryTaskEntry[] {
  const entries: HistoryTaskEntry[] = [];

  if (session.current_messages.length > 0) {
    const preview = session.current_messages.find((m) => m.role === 'user')?.content;
    entries.push({
      taskId: LOG_IN_FLIGHT_TASK_ID,
      label: 'in-flight (current task)',
      description: clip(typeof preview === 'string' ? preview : '(no user message)', 72),
      kind: 'in_flight',
    });
  }

  const transcriptById = new Map(
    listTranscriptTaskRecords(session.session_id).map((r) => [r.task_id, r]),
  );
  const seen = new Set<string>();

  for (let i = session.tasks.length - 1; i >= 0; i--) {
    const task = session.tasks[i]!;
    seen.add(task.task_id);
    const transcript = transcriptById.get(task.task_id);
    const assistantCount = transcript
      ? transcript.messages.filter((m) => m.role === 'assistant').length
      : task.current_work?.trim()
        ? 1
        : 0;
    entries.push({
      taskId: task.task_id,
      label: `${task.task_id}  [${task.turn_range[0]}–${task.turn_range[1]}]`,
      description: `${clip(task.user_intent, 48)} · ${assistantCount} assistant · ${task.tools_used.length} tools`,
      kind: 'completed',
    });
  }

  for (const record of [...transcriptById.values()].reverse()) {
    if (seen.has(record.task_id)) continue;
    const userCount = record.messages.filter((m) => m.role === 'user').length;
    const assistantCount = record.messages.filter((m) => m.role === 'assistant').length;
    entries.push({
      taskId: record.task_id,
      label: `${record.task_id}  [${record.turn_range[0]}–${record.turn_range[1]}]`,
      description: `${userCount} user · ${assistantCount} assistant`,
      kind: 'completed',
    });
  }

  return entries;
}

function linesFromTranscriptMessages(messages: TranscriptMessage[]): HistoryLineEntry[] {
  const lines: HistoryLineEntry[] = [];
  let userIdx = 0;
  let assistantIdx = 0;

  for (const msg of messages) {
    if (msg.role === 'user') {
      lines.push({
        value: `user:${userIdx++}`,
        label: `[user] ${clip(msg.content, 56)}`,
        description: clip(msg.content, 80),
        kind: 'user',
        body: msg.content,
      });
      continue;
    }

    if (msg.role === 'assistant') {
      const suffix = msg.has_tool_calls ? ' (tools)' : '';
      lines.push({
        value: `assistant:${assistantIdx++}`,
        label: `[assistant${suffix}] ${clip(msg.content, 52)}`,
        description: clip(msg.content, 80),
        kind: 'assistant',
        body: msg.content,
      });
      continue;
    }

    if (msg.role === 'tool') {
      lines.push({
        value: `tool:${msg.action_id}`,
        label: `→ ${msg.tool_name}  ${msg.action_id}`,
        description: msg.preview,
        kind: 'tool',
        actionId: msg.action_id,
      });
    }
  }

  return lines;
}

function linesFromTaskSummary(task: TaskSummaryDoc): HistoryLineEntry[] {
  const lines: HistoryLineEntry[] = [];

  if (task.user_messages.length > 0) {
    lines.push({
      value: '__section_user__',
      label: '— user (summary only) —',
      description: `${task.user_messages.length} message(s)`,
      kind: 'section',
    });
    task.user_messages.forEach((msg, i) => {
      lines.push({
        value: `user:${i}`,
        label: `[user] ${clip(msg, 56)}`,
        description: clip(msg, 80),
        kind: 'user',
        body: msg,
      });
    });
  }

  if (task.current_work?.trim()) {
    lines.push({
      value: 'assistant:0',
      label: `[assistant] ${clip(task.current_work, 52)}`,
      description: clip(task.current_work, 80),
      kind: 'assistant',
      body: task.current_work,
    });
  }

  return lines;
}

function linesForInFlightTask(session: SessionFile): HistoryLineEntry[] {
  const lines: HistoryLineEntry[] = [];
  let userIdx = 0;
  let assistantIdx = 0;

  for (const msg of session.current_messages) {
    if (msg.role === 'user') {
      const text = typeof msg.content === 'string' ? msg.content : '';
      lines.push({
        value: `user:${userIdx++}`,
        label: `[user] ${clip(text, 56)}`,
        description: clip(text, 80),
        kind: 'user',
        body: text,
      });
      continue;
    }

    if (msg.role === 'assistant') {
      const raw = typeof msg.content === 'string' ? msg.content : '';
      const clean = extractCleanAnswer(raw);
      const suffix = msg.tool_calls?.length ? ' (tools)' : '';
      lines.push({
        value: `assistant:${assistantIdx++}`,
        label: `[assistant${suffix}] ${clip(clean, 52)}`,
        description: clip(clean, 80),
        kind: 'assistant',
        body: clean,
      });
      continue;
    }

    if (msg.role === 'tool') {
      const content = typeof msg.content === 'string' ? msg.content : '';
      const actionId =
        msg.action_id ?? content.match(/\[action:([^\]]+)\]/)?.[1];
      if (actionId) {
        lines.push({
          value: `tool:${actionId}`,
          label: `→ tool  ${actionId}`,
          description: clip(content, 80),
          kind: 'tool',
          actionId,
        });
      }
    }
  }

  return lines;
}

export function listHistoryLines(
  session: SessionFile,
  taskId: string,
): HistoryLineEntry[] {
  if (taskId === LOG_IN_FLIGHT_TASK_ID) {
    return linesForInFlightTask(session);
  }

  const transcript =
    readTranscriptTask(session.session_id, taskId) ??
    null;
  if (transcript && transcript.messages.length > 0) {
    return linesFromTranscriptMessages(transcript.messages);
  }

  const task = session.tasks.find((t) => t.task_id === taskId);
  if (!task) return [];
  return linesFromTaskSummary(task);
}