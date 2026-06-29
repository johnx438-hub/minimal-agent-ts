import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

import type { WorkflowDefinition } from './types.js';

export function loadWorkflowDefinition(workflowPath: string, cwd: string): WorkflowDefinition {
  const path = isAbsolute(workflowPath) ? workflowPath : resolve(cwd, workflowPath);
  if (!existsSync(path)) {
    throw new Error(`Workflow file not found: ${path}`);
  }

  const raw = JSON.parse(readFileSync(path, 'utf8')) as WorkflowDefinition;
  if (!raw.name || !raw.roles || !raw.flow?.length) {
    throw new Error('Invalid workflow: requires name, roles, and flow[]');
  }

  return raw;
}