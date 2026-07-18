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
        'Put the **full numbered plan** in `workflow_handoff.summary` (self-contained for the next role); ' +
        'do not leave the real plan only in chat with a stub summary. ' +
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
 * Append to role system prompt.
 * Strong negative-feedback framing for “must hand off” (workflow-specific copy —
 * not a paste of any third-party compression prompt). Failure → parent session
 * keeps history; pipeline simply cannot advance.
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
    '',
    '## What counts as success for this step',
    `Only a clear **handoff** into slot \`${meta.slot}\` advances the pipeline.`,
    'Exploration and edits that never become a handoff are treated as incomplete work.',
    '',
    '## How to hand off (pick one)',
    `1. **Preferred:** call \`${'workflow_handoff'}\` once with a complete, self-contained summary` +
      ' (the next role does **not** see this chat; reviewers: include verdict). ' +
      'Then send a short final reply and end the step.',
    '2. **Also valid:** end with a single final message that *is* the full handoff body' +
      ' (no tool required). Downstream reads that text as this slot’s output.',
    '',
    '## Negative feedback (what hurts this step)',
    '- Tooling with no eventual handoff burns max_turns and still fails the step.',
    '- After the deliverable is already clear, more tool calls do not improve the handoff' +
      ' and risk turn_ceiling / early handback.',
    '- Vague or empty endings leave the next role with nothing usable — same as failing the step.',
    '- A long plan in chat plus a tiny handoff.summary starves the next role ' +
      '(downstream reads the slot, not your monologue).',
    '',
    '## If there is no usable handoff',
    'This step fails. Control returns to the **parent session** (chat history preserved).',
    'The workflow does not invent a substitute deliverable for you.',
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
