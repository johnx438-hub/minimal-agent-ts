/**
 * Optional structured handoff tool — only exposed on workflow role runs
 * (config.workflowRole set + allowlist). Final text remains a valid handoff.
 */

import type { ToolDefinition } from '../types.js';

export const WORKFLOW_HANDOFF_TOOL = 'workflow_handoff';

export interface WorkflowHandoffPayload {
  kind: string;
  summary: string;
  verdict?: string;
  assumptions?: string;
  open_questions?: string;
  artifacts?: string[];
}

export interface WorkflowRoleRuntime {
  /** Last structured handoff from workflow_handoff in this step. */
  handoff: WorkflowHandoffPayload | null;
}

export const WORKFLOW_HANDOFF_DEFINITIONS: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: WORKFLOW_HANDOFF_TOOL,
      description:
        'Record this workflow step’s handoff for the next role (preferred when done). ' +
        'After calling once with a clear summary, stop tools and finish. ' +
        'Your final message may repeat the summary. Reviewers should set verdict. ' +
        'Not available outside workflow roles.',
      parameters: {
        type: 'object',
        properties: {
          kind: {
            type: 'string',
            description: 'Handoff kind: plan | impl_summary | review | note',
          },
          summary: {
            type: 'string',
            description:
              'Primary handoff text for the next step (required). Must be self-contained: ' +
              'the next role does not see this chat. For plans, put the full numbered plan here—not a stub.',
          },
          verdict: {
            type: 'string',
            description:
              'Reviewers: approved | needs_revision | needs_human. Others usually omit.',
          },
          assumptions: {
            type: 'string',
            description: 'Assumptions made when the user goal was incomplete.',
          },
          open_questions: {
            type: 'string',
            description: 'Open questions for a human if needs_human.',
          },
          artifacts: {
            type: 'array',
            items: { type: 'string' },
            description: 'Paths or artifact ids touched (optional).',
          },
        },
        required: ['kind', 'summary'],
      },
    },
  },
];

export function formatHandoffPayloadAsOutput(p: WorkflowHandoffPayload): string {
  const lines = [
    `## Handoff (${p.kind})`,
    p.summary.trim(),
  ];
  if (p.assumptions?.trim()) {
    lines.push('', '## Assumptions', p.assumptions.trim());
  }
  if (p.open_questions?.trim()) {
    lines.push('', '## Open questions', p.open_questions.trim());
  }
  if (p.artifacts?.length) {
    lines.push('', '## Artifacts', ...p.artifacts.map((a) => `- ${a}`));
  }
  if (p.verdict?.trim()) {
    lines.push(
      '',
      '```json',
      JSON.stringify({ verdict: p.verdict.trim() }),
      '```',
    );
  }
  return lines.join('\n');
}

/**
 * Minimal guard for models that monologue a full plan then call
 * workflow_handoff with a stub summary. Slot output prefers structured handoff;
 * when summary is thin and final text is much richer, expand summary from final.
 */
export const HANDOFF_SUMMARY_THIN_CHARS = 160;
export const HANDOFF_FINAL_EXPAND_MIN_CHARS = 400;
export const HANDOFF_FINAL_VS_SUMMARY_RATIO = 2.5;

export interface ResolveHandoffSlotResult {
  output: string;
  /** True when final message replaced a thin tool summary. */
  merged: boolean;
  warning?: string;
}

function isThinHandoffSummary(summary: string, finalText: string): boolean {
  const s = summary.trim();
  const f = finalText.trim();
  if (!s || !f) return false;
  if (f.length < HANDOFF_FINAL_EXPAND_MIN_CHARS) return false;
  if (s.length >= HANDOFF_SUMMARY_THIN_CHARS && f.length < s.length * HANDOFF_FINAL_VS_SUMMARY_RATIO) {
    return false;
  }
  // Thin: short absolute summary, or final substantially longer than summary.
  if (s.length < HANDOFF_SUMMARY_THIN_CHARS) return true;
  return f.length >= s.length * HANDOFF_FINAL_VS_SUMMARY_RATIO;
}

/**
 * Prefer structured handoff; if summary is a stub vs a long final message,
 * re-format with final text as summary body and keep kind/verdict/artifacts.
 */
export function resolveHandoffSlotOutput(
  structured: WorkflowHandoffPayload | null | undefined,
  finalText: string,
): ResolveHandoffSlotResult {
  const final = (finalText ?? '').trim();
  if (!structured) {
    return { output: finalText ?? '', merged: false };
  }

  const summary = structured.summary?.trim() ?? '';
  if (isThinHandoffSummary(summary, final) && final.length > summary.length) {
    const warning =
      `handoff: expanded slot from final message ` +
      `(summary ${summary.length} chars → final ${final.length} chars; ` +
      `tool summary was thin vs monologue)`;
    const expanded: WorkflowHandoffPayload = {
      ...structured,
      summary: final,
    };
    const body = formatHandoffPayloadAsOutput(expanded);
    return {
      output: `> ⚠ ${warning}\n\n${body}`,
      merged: true,
      warning,
    };
  }

  return {
    output: formatHandoffPayloadAsOutput(structured),
    merged: false,
  };
}

export function runWorkflowHandoffTool(
  args: Record<string, unknown>,
  runtime: WorkflowRoleRuntime | undefined,
): string {
  if (!runtime) {
    return 'error: workflow_handoff is only available inside a workflow role step';
  }
  const kind = String(args.kind ?? 'note').trim() || 'note';
  const summary = String(args.summary ?? '').trim();
  if (!summary) {
    return 'error: summary is required for workflow_handoff';
  }
  const verdictRaw = args.verdict !== undefined ? String(args.verdict).trim() : '';
  const artifacts = Array.isArray(args.artifacts)
    ? args.artifacts.map((a) => String(a)).filter(Boolean)
    : undefined;

  runtime.handoff = {
    kind,
    summary,
    verdict: verdictRaw || undefined,
    assumptions:
      args.assumptions !== undefined ? String(args.assumptions) : undefined,
    open_questions:
      args.open_questions !== undefined ? String(args.open_questions) : undefined,
    artifacts,
  };

  return (
    `ok: handoff recorded (kind=${kind}` +
    (verdictRaw ? `, verdict=${verdictRaw}` : '') +
    `). Stop calling tools; your final reply may briefly confirm the handoff.`
  );
}
