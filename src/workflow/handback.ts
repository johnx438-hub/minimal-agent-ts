import { stripLoopGuardInjections } from '../loop-guard.js';
import type { ChatMessage } from '../types.js';
import type { WorkflowContext, WorkflowHandback, WorkflowResult } from './types.js';

const AGENT_STOPPED_RE = /^\[Agent stopped: (.+)\]$/s;

const SUMMARY_FINAL_MAX = 4000;
const SUMMARY_SLOT_MAX = 500;

export function parseAgentStopReason(text: string): string | null {
  const m = text.trim().match(AGENT_STOPPED_RE);
  return m?.[1]?.trim() ?? null;
}

export function classifyAgentStopReason(detail: string): WorkflowHandback['reason'] {
  const lower = detail.toLowerCase();
  if (lower.includes('loop_guard') || lower.includes('loop detected')) {
    return 'loop_guard';
  }
  if (lower.includes('turn ceiling')) {
    return 'turn_ceiling';
  }
  return 'agent_stopped';
}

export function formatWorkflowHandbackMessage(hb: WorkflowHandback): string {
  const lines = [
    '═'.repeat(60),
    '⚠ Workflow handback — needs your input',
    '═'.repeat(60),
    '',
  ];

  switch (hb.reason) {
    case 'loop_guard':
      lines.push(
        `Role "${hb.role ?? 'unknown'}" stopped: loop guard terminated the step.`,
        `Detail: ${hb.detail}`,
      );
      break;
    case 'max_rounds_exhausted':
      lines.push(
        `Review loop exhausted after ${hb.round ?? '?'} round(s); exit condition still true.`,
        hb.detail,
      );
      break;
    case 'turn_ceiling':
      lines.push(
        `Role "${hb.role ?? 'unknown'}" hit turn ceiling.`,
        `Detail: ${hb.detail}`,
      );
      break;
    case 'agent_stopped':
      lines.push(
        `Role "${hb.role ?? 'unknown'}" stopped unexpectedly.`,
        `Detail: ${hb.detail}`,
      );
      break;
    case 'dag_exhausted':
      lines.push(
        'DAG scheduler stopped (iteration limit or unfinished nodes).',
        `Detail: ${hb.detail}`,
      );
      break;
    case 'needs_human':
      lines.push(
        `Role "${hb.role ?? 'unknown'}" needs human input (goal unclear or blocked).`,
        `Detail: ${hb.detail}`,
        'Clarify the task in chat, then re-arm the workflow if needed.',
      );
      break;
  }

  if (hb.partial_output) {
    const preview =
      hb.partial_output.length > 800
        ? `${hb.partial_output.slice(0, 800)}…`
        : hb.partial_output;
    lines.push('', 'Last role output:', preview);
  }

  lines.push(
    '',
    'Workflow ended — you are back at the main prompt.',
    'Next: continue in chat, /brief, revise the task, or re-arm workflow.',
    '═'.repeat(60),
  );

  return lines.join('\n');
}

export function buildHandbackWorkflowResult(opts: {
  workflowName: string;
  sessionId: string;
  context: WorkflowContext;
  handback: WorkflowHandback;
}): WorkflowResult {
  return {
    text: formatWorkflowHandbackMessage(opts.handback),
    workflow: opts.workflowName,
    context: opts.context,
    sessionId: opts.sessionId,
    handback: opts.handback,
  };
}

function clip(text: string, max: number): string {
  const t = text.trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max)}…`;
}

/**
 * Spawn-like return body for the parent session: success summary or handback.
 * Does not replace the full multi-role transcript — only a compact digest.
 */
export function formatWorkflowReturnSummary(opts: {
  workflowName: string;
  userTask: string;
  resultText: string;
  context: WorkflowContext;
  handback?: WorkflowHandback;
}): string {
  if (opts.handback) {
    return formatWorkflowHandbackMessage(opts.handback);
  }

  const lines = [
    '═'.repeat(60),
    `✓ Workflow complete: ${opts.workflowName}`,
    '═'.repeat(60),
    '',
    '## Task',
    clip(opts.userTask, 1200) || '(empty)',
    '',
  ];

  const slots = Object.keys(opts.context.roles);
  if (slots.length > 0) {
    lines.push('## Role slots');
    for (const name of slots) {
      const r = opts.context.roles[name]!;
      const verdict = r.verdict ? ` [verdict=${r.verdict}]` : '';
      lines.push(`- **${name}**${verdict}: ${clip(r.output, SUMMARY_SLOT_MAX) || '(empty)'}`);
    }
    lines.push('');
  }

  lines.push(
    '## Final output',
    clip(opts.resultText, SUMMARY_FINAL_MAX) || '(no final text)',
    '',
    'Parent session history was preserved; this block is the workflow digest (spawn-style).',
    'Next: continue in chat, /brief, or re-arm a workflow.',
    '═'.repeat(60),
  );

  return lines.join('\n');
}

/**
 * Restore pre-workflow messages and append user task + assistant digest
 * (same idea as spawn: child work stays out of parent history; result returns as text).
 */
export function mergeWorkflowResultIntoSessionMessages(
  priorMessages: ChatMessage[],
  userTask: string,
  summaryText: string,
): ChatMessage[] {
  const prior = stripLoopGuardInjections(priorMessages);
  const taskLine = userTask.trim() || '(workflow task)';
  return [
    ...prior,
    {
      role: 'user',
      content: `Working directory task (workflow):\n${taskLine}`,
    },
    {
      role: 'assistant',
      content: summaryText,
    },
  ];
}