import type { WorkflowContext } from './types.js';

const TEMPLATE_RE = /\{\{([a-zA-Z0-9_.]+)\}\}/g;

function lookupPath(ctx: WorkflowContext, path: string): string {
  if (path === 'user_task') {
    return ctx.user_task;
  }

  const dot = path.indexOf('.');
  if (dot <= 0) {
    const role = ctx.roles[path];
    return role?.output ?? '';
  }

  const roleName = path.slice(0, dot);
  const field = path.slice(dot + 1);
  const role = ctx.roles[roleName];
  if (!role) return '';

  if (field === 'output') return role.output;
  if (field === 'verdict') return role.verdict ?? '';
  return '';
}

export function renderWorkflowTemplate(template: string, ctx: WorkflowContext): string {
  return template.replace(TEMPLATE_RE, (_match, path: string) => lookupPath(ctx, path));
}

/** Supports `{{reviewer.verdict}} == 'needs_revision'`. */
export function evaluateWorkflowWhen(expression: string, ctx: WorkflowContext): boolean {
  const trimmed = expression.trim();
  const eqMatch = trimmed.match(/^(.+?)\s*==\s*['"]([^'"]+)['"]\s*$/);
  if (!eqMatch) {
    return false;
  }

  const left = eqMatch[1].trim();
  const expected = eqMatch[2];
  const leftRendered = left.includes('{{')
    ? renderWorkflowTemplate(left, ctx)
    : lookupPath(ctx, left.replace(/^\{\{|\}\}$/g, ''));

  return leftRendered.trim() === expected;
}