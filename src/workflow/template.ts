import type { WorkflowContext, WorkflowWhen, WorkflowWhenClause } from './types.js';

const TEMPLATE_RE = /\{\{([a-zA-Z0-9_.]+)\}\}/g;

export function lookupWorkflowPath(ctx: WorkflowContext, path: string): string {
  const cleaned = path.replace(/^\{\{|\}\}$/g, '').trim();
  if (cleaned === 'user_task') {
    return ctx.user_task;
  }

  const dot = cleaned.indexOf('.');
  if (dot <= 0) {
    const role = ctx.roles[cleaned];
    return role?.output ?? '';
  }

  const roleName = cleaned.slice(0, dot);
  const field = cleaned.slice(dot + 1);
  const role = ctx.roles[roleName];
  if (!role) return '';

  if (field === 'output') return role.output;
  if (field === 'verdict') return role.verdict ?? '';
  return '';
}

export function renderWorkflowTemplate(template: string, ctx: WorkflowContext): string {
  return template.replace(TEMPLATE_RE, (_match, path: string) =>
    lookupWorkflowPath(ctx, path),
  );
}

export function isWhenClause(value: unknown): value is WorkflowWhenClause {
  return (
    Boolean(value) &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    typeof (value as WorkflowWhenClause).path === 'string' &&
    typeof (value as WorkflowWhenClause).eq === 'string'
  );
}

/**
 * Evaluate loop/switch conditions.
 * - String: `{{reviewer.verdict}} == 'needs_revision'` (legacy)
 * - Object: `{ path: "reviewer.verdict", eq: "needs_revision" }`
 */
export function evaluateWorkflowWhen(when: WorkflowWhen, ctx: WorkflowContext): boolean {
  if (isWhenClause(when)) {
    const left = lookupWorkflowPath(ctx, when.path).trim();
    return left === when.eq.trim();
  }

  if (typeof when !== 'string') return false;

  const trimmed = when.trim();
  const eqMatch = trimmed.match(/^(.+?)\s*==\s*['"]([^'"]+)['"]\s*$/);
  if (!eqMatch) {
    return false;
  }

  const left = eqMatch[1]!.trim();
  const expected = eqMatch[2]!;
  const leftRendered = left.includes('{{')
    ? renderWorkflowTemplate(left, ctx)
    : lookupWorkflowPath(ctx, left);

  return leftRendered.trim() === expected;
}

/** Resolve switch `on` to a branch key string. */
export function resolveSwitchOn(on: string, ctx: WorkflowContext): string {
  const trimmed = on.trim();
  if (trimmed.includes('{{')) {
    return renderWorkflowTemplate(trimmed, ctx).trim();
  }
  return lookupWorkflowPath(ctx, trimmed).trim();
}
