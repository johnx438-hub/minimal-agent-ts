import { existsSync, readFileSync, writeFileSync } from 'node:fs';

import { listActions } from './action-store.js';
import type { SessionFile, TaskSummaryDoc } from './types.js';
import { ensureSessionsDir, getWorkspaceRoot, handoffPath } from './workspace.js';

export function getHandoffPath(sessionId: string): string {
  return handoffPath(sessionId);
}

function latestUserIntent(session: SessionFile): string {
  for (let i = session.current_messages.length - 1; i >= 0; i--) {
    const msg = session.current_messages[i];
    if (msg.role === 'user' && msg.content?.trim()) {
      return msg.content.trim();
    }
  }
  const lastTask = session.tasks[session.tasks.length - 1];
  return lastTask?.user_intent ?? '(none)';
}

function collectFilesTouched(session: SessionFile): string[] {
  const files = new Set<string>();
  for (const task of session.tasks) {
    for (const f of task.files_touched) files.add(f);
  }
  return [...files].sort();
}

function formatTaskSection(task: TaskSummaryDoc): string {
  const lines = [
    `### ${task.task_id}`,
    `- Intent: ${task.user_intent.slice(0, 500)}`,
    `- Work: ${task.current_work || '(none)'}`,
    `- Pending: ${task.pending_tasks.length > 0 ? task.pending_tasks.join('; ') : '(none)'}`,
    `- Files: ${task.files_touched.join(', ') || '(none)'}`,
    `- Tools: ${task.tools_used.join(', ') || '(none)'}`,
    `- Turns: ${task.turn_range[0]}–${task.turn_range[1]} (${task.action_count} actions)`,
  ];
  return lines.join('\n');
}

function formatActionHandles(sessionId: string): string {
  const actions = listActions(sessionId).slice(0, 30);
  if (actions.length === 0) return '(no action blocks yet)';
  return actions
    .map(
      (a) =>
        `- \`${a.action_id}\` ${a.tool_name}` +
        (a.files_touched.length > 0 ? ` → ${a.files_touched.join(', ')}` : ''),
    )
    .join('\n');
}

/** Build markdown handoff document from session state. */
export function buildHandoffMarkdown(session: SessionFile, cwd: string): string {
  const generated = new Date().toISOString();
  const files = collectFilesTouched(session);
  const lastTask = session.tasks[session.tasks.length - 1];

  const sections = [
    `# Handoff — ${session.session_id}`,
    '',
    `Generated: ${generated}`,
    `CWD: ${cwd}`,
    `Completed tasks: ${session.tasks.length}`,
    `In-flight messages: ${session.current_messages.length}`,
    '',
    '## Latest intent',
    latestUserIntent(session),
    '',
  ];

  if (lastTask) {
    sections.push('## Current work (last task summary)', lastTask.current_work || '(none)', '');
    if (lastTask.pending_tasks.length > 0) {
      sections.push('## Pending tasks', ...lastTask.pending_tasks.map((t) => `- ${t}`), '');
    }
  }

  if (session.tasks.length > 0) {
    sections.push('## Completed tasks', ...session.tasks.map(formatTaskSection), '');
  }

  if (files.length > 0) {
    sections.push('## Files touched', ...files.map((f) => `- ${f}`), '');
  }

  sections.push(
    '## Action handles (use recall_query)',
    formatActionHandles(session.session_id),
    '',
    '## Resume hint',
    'Load this file in a new session (`/handoff load` or `--handoff`).',
    'Large tool output is in cold storage — `recall_query(action_id="...")` for full text.',
  );

  return sections.join('\n');
}

/** Write handoff markdown; returns absolute path. */
export function writeHandoffFile(session: SessionFile): string {
  ensureSessionsDir();
  const path = getHandoffPath(session.session_id);
  const content = buildHandoffMarkdown(session, getWorkspaceRoot());
  writeFileSync(path, content, 'utf8');
  return path;
}

/** Read handoff markdown for a session; null if missing. */
export function readHandoffFile(sessionId: string): string | null {
  const path = getHandoffPath(sessionId);
  if (!existsSync(path)) return null;
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

/** Wrap handoff body for injection as the next user task prefix. */
export function formatHandoffInjection(content: string): string {
  return (
    '[Handoff from prior session — continue from this context]\n\n' +
    content.trim() +
    '\n\n[End handoff — proceed with the task below]'
  );
}