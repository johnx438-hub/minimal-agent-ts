import { resolve } from 'node:path';

import { loadWorkflowDefinition } from './workflow/load-workflow.js';
import { resolveWorkflowRole } from './workflow/load-role.js';

export interface WorkflowRoleCheckpoint {
  name: string;
  tools: string[];
  needsShell: boolean;
  needsWeb: boolean;
}

export interface WorkflowCheckpointInfo {
  name: string;
  path: string;
  roles: WorkflowRoleCheckpoint[];
  needsShell: boolean;
  needsWeb: boolean;
}

function roleNeedsShell(tools: string[]): boolean {
  return tools.includes('run_shell');
}

function roleNeedsWeb(tools: string[]): boolean {
  return tools.includes('web_fetch');
}

export function buildWorkflowCheckpoint(workflowPath: string, cwd: string): WorkflowCheckpointInfo {
  const definition = loadWorkflowDefinition(workflowPath, cwd);
  const roles: WorkflowRoleCheckpoint[] = [];

  for (const [name, roleConfig] of Object.entries(definition.roles)) {
    const resolved = resolveWorkflowRole(name, roleConfig, workflowPath);
    const tools = resolved.tools;
    roles.push({
      name,
      tools,
      needsShell: roleNeedsShell(tools),
      needsWeb: roleNeedsWeb(tools),
    });
  }

  const needsShell = roles.some((r) => r.needsShell);
  const needsWeb = roles.some((r) => r.needsWeb);

  return {
    name: definition.name,
    path: resolve(workflowPath),
    roles,
    needsShell,
    needsWeb,
  };
}

export function formatWorkflowCheckpoint(info: WorkflowCheckpointInfo): string {
  const lines: string[] = [
    `Workflow "${info.name}" will run with:`,
    `  shell: ${info.needsShell ? 'required' : 'not required'}`,
    `  web:   ${info.needsWeb ? 'required' : 'not required'}`,
    '  roles:',
  ];

  for (const role of info.roles) {
    const flags = [
      role.needsShell ? 'shell' : null,
      role.needsWeb ? 'web' : null,
    ]
      .filter(Boolean)
      .join(', ');
    const suffix = flags ? ` (${flags})` : '';
    lines.push(`    • ${role.name}: ${role.tools.join(', ') || '(none)'}${suffix}`);
  }

  lines.push('This confirmation cannot be skipped or remembered (workflow entry).');
  return lines.join('\n');
}