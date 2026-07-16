import { isAbsolute, resolve, sep } from 'node:path';

import type { AgentConfig } from '../types.js';
import {
  findGrantForPath,
  getWorkspaceGrants,
  isPathUnderRoot,
  isPathWritableByGrants,
} from '../workspace.js';

export function pathWouldEscape(cwd: string, input: string): boolean {
  const target = isAbsolute(input) ? input : resolve(cwd, input);
  return !isPathUnderRoot(cwd, target);
}

function effectiveGrants(config: AgentConfig) {
  return config.workspaceGrants?.length
    ? config.workspaceGrants
    : getWorkspaceGrants();
}

export function resolveSafePath(cwd: string, input: string): string {
  const target = isAbsolute(input) ? input : resolve(cwd, input);
  if (!isPathUnderRoot(cwd, target)) {
    throw new Error(`path escapes working directory: ${input}`);
  }
  return target;
}

const PATH_ESCAPE_ERROR = (input: string) =>
  `path escapes working directory: ${input}`;

/**
 * Resolve a path for read-only tools.
 * Allowed if under cwd, under a workspace grant, or JIT path_escape approval.
 */
export async function resolveReadablePath(
  config: AgentConfig,
  input: string,
  reason: string,
): Promise<string> {
  const target = isAbsolute(input) ? input : resolve(config.cwd, input);
  if (isPathUnderRoot(config.cwd, target)) {
    return target;
  }

  const grants = effectiveGrants(config);
  for (const g of grants) {
    if (isPathUnderRoot(g.root, target)) {
      return target;
    }
  }

  const gate = config.permissionGate;
  if (!gate || !(await gate.ensurePathEscape(config, reason))) {
    if (config.abortSignal?.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }
    throw new Error(PATH_ESCAPE_ERROR(input));
  }
  return target;
}

/**
 * Write/edit paths: under cwd or under a read_write grant.
 * Prefer passing full config (same as readable) for grant resolution.
 */
export function resolveWritablePath(
  cwdOrConfig: string | AgentConfig,
  input: string,
): string {
  const cwd = typeof cwdOrConfig === 'string' ? cwdOrConfig : cwdOrConfig.cwd;
  const grants =
    typeof cwdOrConfig === 'string'
      ? getWorkspaceGrants()
      : effectiveGrants(cwdOrConfig);

  const target = isAbsolute(input) ? input : resolve(cwd, input);
  if (isPathUnderRoot(cwd, target)) {
    return target;
  }
  for (const g of grants) {
    if (g.mode === 'read_write' && isPathUnderRoot(g.root, target)) {
      return target;
    }
  }
  if (isPathWritableByGrants(target)) {
    return target;
  }
  const g = findGrantForPath(target);
  if (g?.mode === 'read_write') {
    return target;
  }
  throw new Error(PATH_ESCAPE_ERROR(input));
}

export function sliceLines(text: string, offset?: number, limit?: number): string {
  const lines = text.split('\n');
  const start = Math.max(0, (offset ?? 1) - 1);
  const end = limit === undefined ? lines.length : start + limit;
  return lines.slice(start, end).join('\n');
}

/** True when changing cwd leaves the current directory tree (needs user confirm in TUI). */
export function cwdChangeNeedsConfirm(fromCwd: string, toPath: string): boolean {
  const from = resolve(fromCwd);
  const to = resolve(toPath);
  if (to === from) return false;
  return !(to.startsWith(from + sep) || from.startsWith(to + sep));
}
