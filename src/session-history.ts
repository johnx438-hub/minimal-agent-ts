import { listActions, loadAction } from './action-store.js';
import { buildGenericPreview, DEFAULT_PREVIEW_POLICY } from './action-preview.js';
import type { ActionBlock, SessionFile, TaskSummaryDoc } from './types.js';

/** Sentinel task id for in-flight context in history browser. */
export const HISTORY_IN_FLIGHT_TASK_ID = '__in_flight__';

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
  kind: 'user' | 'assistant' | 'tool' | 'action' | 'section';
  actionId?: string;
}

function clip(text: string, max = 72): string {
  const one = text.replace(/\s+/g, ' ').trim();
  if (!one) return '(empty)';
  if (one.length <= max) return one;
  return `${one.slice(0, max - 1)}…`;
}

function parseActionIdFromToolContent(content: string | null): string | undefined {
  if (!content) return undefined;
  const match = content.match(/\[action:([^\]]+)\]/);
  return match?.[1];
}

function formatActionLabel(block: ActionBlock): string {
  const path = block.files_touched[0];
  const pathNote = path ? ` · ${clip(path, 40)}` : '';
  return `→ ${block.tool_name}  turn ${block.turn_number}${pathNote}`;
}

function formatActionDescription(block: ActionBlock): string {
  if (block.preview_summary) return clip(block.preview_summary, 80);
  if (block.preview_lines && block.preview_lines.length > 0) {
    return clip(block.preview_lines.join(' '), 80);
  }
  const preview = buildGenericPreview(
    block.result_text,
    block.byte_size,
    DEFAULT_PREVIEW_POLICY,
  );
  if (preview.summary) return clip(preview.summary, 80);
  return clip(preview.preview_lines.join(' '), 80);
}

export function listHistoryTasks(session: SessionFile): HistoryTaskEntry[] {
  const entries: HistoryTaskEntry[] = [];

  if (session.current_messages.length > 0) {
    const preview = session.current_messages.find((m) => m.role === 'user')?.content;
    entries.push({
      taskId: HISTORY_IN_FLIGHT_TASK_ID,
      label: 'in-flight (current task)',
      description: clip(typeof preview === 'string' ? preview : '(no user message)', 72),
      kind: 'in_flight',
    });
  }

  for (let i = session.tasks.length - 1; i >= 0; i--) {
    const task = session.tasks[i]!;
    const tools =
      task.tools_used.length > 0 ? task.tools_used.join(', ') : 'no tools';
    entries.push({
      taskId: task.task_id,
      label: `${task.task_id}  [${task.turn_range[0]}–${task.turn_range[1]}]`,
      description: `${clip(task.user_intent, 48)} · ${task.action_count} actions · ${tools}`,
      kind: 'completed',
    });
  }

  return entries;
}

function linesForCompletedTask(
  session: SessionFile,
  task: TaskSummaryDoc,
): HistoryLineEntry[] {
  const lines: HistoryLineEntry[] = [];

  if (task.user_messages.length > 0) {
    lines.push({
      value: '__section_user__',
      label: '— user —',
      description: `${task.user_messages.length} message(s)`,
      kind: 'section',
    });
    task.user_messages.forEach((msg, i) => {
      lines.push({
        value: `user:${i}`,
        label: `[user] ${clip(msg, 56)}`,
        description: clip(msg, 80),
        kind: 'user',
      });
    });
  }

  const actions = listActions(session.session_id, task.task_id).sort(
    (a, b) => a.turn_number - b.turn_number || a.timestamp - b.timestamp,
  );

  if (actions.length > 0) {
    lines.push({
      value: '__section_actions__',
      label: '— actions —',
      description: `${actions.length} tool invocation(s)`,
      kind: 'section',
    });
    for (const block of actions) {
      lines.push({
        value: `action:${block.action_id}`,
        label: formatActionLabel(block),
        description: formatActionDescription(block),
        kind: 'action',
        actionId: block.action_id,
      });
    }
  } else if (task.tools_used.length > 0) {
    lines.push({
      value: '__section_tools_summary__',
      label: '— tools (summary only) —',
      description: task.tools_used.join(', '),
      kind: 'section',
    });
  }

  if (task.current_work?.trim()) {
    lines.push({
      value: '__work__',
      label: '[work]',
      description: clip(task.current_work, 80),
      kind: 'assistant',
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
      });
      continue;
    }

    if (msg.role === 'assistant') {
      const text = typeof msg.content === 'string' ? msg.content : '';
      lines.push({
        value: `assistant:${assistantIdx++}`,
        label: `[assistant] ${clip(text, 56)}`,
        description: clip(text, 80),
        kind: 'assistant',
      });
      continue;
    }

    if (msg.role === 'tool') {
      const content = typeof msg.content === 'string' ? msg.content : '';
      const actionId = msg.action_id ?? parseActionIdFromToolContent(content);
      if (actionId) {
        const block = loadAction(actionId);
        lines.push({
          value: `action:${actionId}`,
          label: block ? formatActionLabel(block) : `→ tool  ${actionId}`,
          description: block
            ? formatActionDescription(block)
            : clip(content, 80),
          kind: 'action',
          actionId,
        });
      } else {
        lines.push({
          value: `tool:${lines.length}`,
          label: `[tool] ${clip(content, 56)}`,
          description: clip(content, 80),
          kind: 'tool',
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
  if (taskId === HISTORY_IN_FLIGHT_TASK_ID) {
    return linesForInFlightTask(session);
  }

  const task = session.tasks.find((t) => t.task_id === taskId);
  if (!task) return [];

  return linesForCompletedTask(session, task);
}

export function buildActionDetailLines(block: ActionBlock): string[] {
  if (block.preview_lines && block.preview_lines.length > 0) {
    return block.preview_lines;
  }
  const preview = buildGenericPreview(
    block.result_text,
    block.byte_size,
    DEFAULT_PREVIEW_POLICY,
  );
  const lines = [...preview.preview_lines];
  if (preview.summary) lines.unshift(preview.summary);
  return lines.length > 0 ? lines : ['(empty)'];
}

export function formatActionDetailTitle(block: ActionBlock): string {
  const path = block.files_touched[0];
  const pathLine = path ? `\npath: ${path}` : '';
  return [
    `${block.tool_name} · ${block.action_id}`,
    `task ${block.task_id} · turn ${block.turn_number} · ${block.byte_size} bytes`,
    pathLine.trimEnd(),
    'Enter/Esc back',
  ]
    .filter(Boolean)
    .join('\n');
}