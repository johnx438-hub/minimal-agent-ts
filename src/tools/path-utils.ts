import { isAbsolute, resolve, sep } from 'node:path';

import type { AgentConfig } from '../types.js';
import {
  findGrantForPath,
  getWorkspaceGrants,
  isPathReadableByGrants,
  isPathWritableByGrants,
} from '../workspace.js';

export function pathWouldEscape(cwd: string, input: string): boolean {
  const target = isAbsolute(input) ? input : resolve(cwd, input);
  const root = resolve(cwd);
  return !(target === root || target.startsWith(root + sep));
}

function isUnderRoot(root: string, target: string): boolean {
  return target === root || target.startsWith(root + sep);
}

function effectiveGrants(config: AgentConfig) {
  return config.workspaceGrants?.length
    ? config.workspaceGrants
    : getWorkspaceGrants();
}

export function resolveSafePath(cwd: string, input: string): string {
  const target = isAbsolute(input) ? input : resolve(cwd, input);
  const root = resolve(cwd);
  if (!isUnderRoot(root, target)) {
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
  const root = resolve(config.cwd);
  if (isUnderRoot(root, target)) {
    return target;
  }

  // Multi-root grants (SPEC_SESSION_WORKSPACE)
  const grants = effectiveGrants(config);
  if (grants.length > 0) {
    const hit = grants.find(
      (g) => target === resolve(g.root) || target.startsWith(resolve(g.root) + sep),
    );
    if (hit) return target;
  } else if (isPathReadableByGrants(target)) {
    return target;
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
 * No JIT write escape.
 */
export function resolveWritablePath(cwd: string, input: string): string {
  const target = isAbsolute(input) ? input : resolve(cwd, input);
  const root = resolve(cwd);
  if (isUnderRoot(root, target)) {
    return target;
  }
  if (isPathWritableByGrants(target)) {
    return target;
  }
  // Also check findGrant in case process grants updated
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
