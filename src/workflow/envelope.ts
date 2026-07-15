/**
 * Role-only workflow envelope (SPEC_WORKFLOW §11).
 * Never injected into the main agent buildSystemPrompt path.
 */

export interface WorkflowEnvelopeMeta {
  workflowName: string;
  role: string;
  /** Context slot written on completion. */
  slot: string;
  phase: string;
  nodeId?: string;
  round?: number;
  /** Whether write tools are available to this role. */
  canWrite: boolean;
  /** Role kind hint for duty line (best-effort from name). */
  dutyHint?: 'planner' | 'worker' | 'reviewer' | 'generic';
}

const WRITE_TOOLS = new Set([
  'write_file',
  'edit_file',
  'apply_patch',
  'office_write',
  'run_shell',
  'test_run',
]);

export function roleCanWrite(tools: string[]): boolean {
  return tools.some((t) => WRITE_TOOLS.has(t));
}

export function inferDutyHint(roleName: string): WorkflowEnvelopeMeta['dutyHint'] {
  const n = roleName.toLowerCase();
  if (n.includes('plan')) return 'planner';
  if (n.includes('review')) return 'reviewer';
  if (n.includes('work') || n.includes('impl') || n.includes('dev')) return 'worker';
  return 'generic';
}

function dutyLine(hint: WorkflowEnvelopeMeta['dutyHint'], canWrite: boolean): string {
  switch (hint) {
    case 'planner':
      return (
        'Duty: produce an executable handoff **plan** only. Do not implement or claim the task is done. ' +
        (canWrite ? '' : 'You have no write tools.')
      );
    case 'worker':
      return (
        'Duty: implement from the upstream **plan** (primary) and task context. ' +
        'Do not re-plan from scratch or redo pure exploration already in the plan.'
      );
    case 'reviewer':
      return (
        'Duty: verify work and set a **verdict** (approved | needs_revision | needs_human). ' +
        'Do not re-implement. Prefer needs_human over endless revision when the goal is unclear.'
      );
    default:
      return (
        'Duty: complete only this role’s step, then hand off. ' +
        'Do not expand into other roles’ jobs.'
      );
  }
}

/**
 * Append to role system prompt. Claude-style “stop tools and summarize” for handoff importance —
 * failure still returns to parent session (no voiding).
 */
export function buildWorkflowRoleEnvelope(meta: WorkflowEnvelopeMeta): string {
  const step = meta.nodeId ? `${meta.nodeId}` : meta.slot;
  const round = meta.round !== undefined ? ` | round: ${meta.round}` : '';
  const duty = dutyLine(meta.dutyHint ?? inferDutyHint(meta.role), meta.canWrite);

  return [
    '',
    '[workflow_envelope]',
    `workflow: ${meta.workflowName}`,
    `step: ${step} | role: ${meta.role} | slot: ${meta.slot} | phase: ${meta.phase}${round}`,
    duty,
    'Handoff: your final message is the handoff body written to the next step as this slot’s output.',
    'Preferred: call workflow_handoff once with a clear summary (and verdict if reviewing), then stop.',
    'When ready to hand off: stop calling tools and produce the handoff text (tool and/or final reply).',
    'Further tool calls after you are ready waste budget and do not improve the handoff.',
    'If you never produce a usable handoff, this step fails and control returns to the parent session',
    '(parent chat history is preserved; the pipeline simply cannot continue cleanly without a handoff).',
    '[/workflow_envelope]',
  ].join('\n');
}

export function applyWorkflowEnvelope(
  baseSystemPrompt: string,
  meta: WorkflowEnvelopeMeta,
): string {
  const base = baseSystemPrompt.trimEnd();
  return `${base}\n${buildWorkflowRoleEnvelope(meta)}`;
}
