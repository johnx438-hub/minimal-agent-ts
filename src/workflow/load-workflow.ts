import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

import type { AgentPluginConfig } from '../plugins/types.js';
import type { WorkflowDefinition } from './types.js';

export function loadWorkflowDefinition(
  workflowPath: string,
  cwd: string,
): WorkflowDefinition {
  const path = isAbsolute(workflowPath) ? workflowPath : resolve(cwd, workflowPath);
  if (!existsSync(path)) {
    throw new Error(`Workflow file not found: ${path}`);
  }

  const raw = JSON.parse(readFileSync(path, 'utf8')) as WorkflowDefinition;
  if (!raw.name || !raw.roles || typeof raw.roles !== 'object') {
    throw new Error('Invalid workflow: requires name and roles');
  }

  const hasFlow = Array.isArray(raw.flow) && raw.flow.length > 0;
  const hasDag =
    Boolean(raw.nodes && typeof raw.nodes === 'object') &&
    typeof raw.entry === 'string' &&
    raw.entry.trim().length > 0 &&
    Array.isArray(raw.edges);

  if (hasFlow && hasDag) {
    throw new Error('Invalid workflow: use either flow[] or nodes+edges+entry, not both');
  }
  if (!hasFlow && !hasDag) {
    throw new Error(
      'Invalid workflow: requires flow[] or DAG (nodes + edges + entry)',
    );
  }

  if (hasDag) {
    const entry = raw.entry!.trim();
    if (!raw.nodes![entry]) {
      throw new Error(`Invalid workflow: entry node "${entry}" not in nodes`);
    }
    for (const e of raw.edges ?? []) {
      if (!raw.nodes![e.from]) {
        throw new Error(`Invalid workflow: edge.from "${e.from}" not in nodes`);
      }
      if (!raw.nodes![e.to]) {
        throw new Error(`Invalid workflow: edge.to "${e.to}" not in nodes`);
      }
    }
  }

  return raw;
}

/**
 * Resolve a workflow name or path to an absolute JSON path.
 * Order: absolute/relative file → agent.json workflows[name] →
 * workflow_dirs / workflows/{name}.json
 */
export function resolveWorkflowRef(
  nameOrPath: string,
  cwd: string,
  plugin?: AgentPluginConfig,
): string | null {
  const raw = nameOrPath.trim();
  if (!raw) return null;

  const tryPath = (p: string): string | null => {
    const abs = isAbsolute(p) ? p : resolve(cwd, p);
    return existsSync(abs) ? abs : null;
  };

  // Explicit path-like
  if (raw.includes('/') || raw.endsWith('.json')) {
    const hit = tryPath(raw);
    if (hit) return hit;
  }

  // Registry map
  const mapped = plugin?.workflows?.[raw] ?? plugin?.workflows?.[raw.replace(/\.json$/, '')];
  if (typeof mapped === 'string' && mapped.trim()) {
    const hit = tryPath(mapped.trim());
    if (hit) return hit;
  }

  // workflow_dirs + default workflows/
  const dirs = [
    ...(plugin?.workflow_dirs ?? []),
    'workflows',
  ];
  const baseName = raw.endsWith('.json') ? raw : `${raw}.json`;
  for (const dir of dirs) {
    const hit = tryPath(resolve(cwd, dir, baseName.includes('/') ? baseName : baseName));
    // dir/name.json
    const hit2 = tryPath(`${dir.replace(/\/$/, '')}/${baseName}`);
    if (hit2) return hit2;
    if (hit) return hit;
  }

  // bare name without extension already tried as workflows/name.json via dirs
  return tryPath(`workflows/${baseName}`);
}
