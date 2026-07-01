import type { WorkflowContext, WorkflowHandback, WorkflowResult } from './types.js';

const AGENT_STOPPED_RE = /^\[Agent stopped: (.+)\]$/s;

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
    'Next: continue in chat, /handoff, revise the task, or re-arm workflow.',
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