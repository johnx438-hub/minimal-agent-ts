/**
 * C5: spawn shell policy — constrain run_shell for child agents (spawnDepth > 0).
 * Main agent (depth 0) is unaffected unless explicitly configured later.
 * git_* / test_run / lsp_query / apply_patch do not go through run_shell (exempt).
 */

import type { SpawnShellMode, SpawnShellPolicy } from '../plugins/types.js';

export type { SpawnShellMode, SpawnShellPolicy };

export interface ShellPolicyVerdict {
  ok: boolean;
  reason?: string;
  /** Effective timeouts after policy clamp (ms). */
  timeout_ms?: number;
  max_timeout_ms?: number;
}

/** Collapse whitespace; trim ends. */
export function normalizeShellCommand(command: string): string {
  return command.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim().replace(/[ \t]+/g, ' ');
}

/**
 * Drop a leading `cd <cwd> &&` / `cd <cwd>;` so allowlist can match the real command.
 */
export function stripLeadingCd(command: string, cwd?: string): string {
  let c = normalizeShellCommand(command);
  if (!cwd) return c;
  const root = cwd.replace(/\/+$/, '');
  if (root.length < 2) return c;

  const patterns = [
    new RegExp(`^cd\\s+${escapeRegExp(root)}\\s*&&\\s*`, 'i'),
    new RegExp(`^cd\\s+${escapeRegExp(root)}\\s*;\\s*`, 'i'),
    new RegExp(`^cd\\s+\\.\\s*&&\\s*`, 'i'),
    new RegExp(`^cd\\s+\\.\\s*;\\s*`, 'i'),
  ];
  for (const re of patterns) {
    if (re.test(c)) {
      c = c.replace(re, '').trim();
      break;
    }
  }
  return c;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Prefix match with token boundary (avoid `npm` matching `npmtest`). */
export function commandMatchesPrefix(command: string, prefix: string): boolean {
  const c = normalizeShellCommand(command);
  const p = normalizeShellCommand(prefix);
  if (!p || !c) return false;
  if (c === p) return true;
  if (p.endsWith(' ')) return c.startsWith(p);
  return c.startsWith(`${p} `) || c.startsWith(`${p}\n`);
}

export function commandMatchesAnyPrefix(command: string, prefixes: string[] | undefined): boolean {
  if (!prefixes?.length) return false;
  return prefixes.some((p) => commandMatchesPrefix(command, p));
}

export function commandMatchesDeny(
  command: string,
  patterns: string[] | undefined,
): string | null {
  if (!patterns?.length) return null;
  const c = normalizeShellCommand(command);
  for (const raw of patterns) {
    const pat = raw?.trim();
    if (!pat) continue;
    try {
      if (new RegExp(pat, 'i').test(c)) return pat;
    } catch {
      // invalid regex — treat as literal substring
      if (c.toLowerCase().includes(pat.toLowerCase())) return pat;
    }
  }
  return null;
}

/** Merge global spawn_policy.shell with preset.shell (preset wins on conflicts). */
export function mergeSpawnShellPolicy(
  globalPolicy?: SpawnShellPolicy | null,
  presetPolicy?: SpawnShellPolicy | null,
): SpawnShellPolicy | undefined {
  if (!globalPolicy && !presetPolicy) return undefined;
  const g = globalPolicy ?? {};
  const p = presetPolicy ?? {};
  return {
    mode: p.mode ?? g.mode ?? 'inherit',
    allowed_prefixes: p.allowed_prefixes ?? g.allowed_prefixes,
    deny_patterns: uniqueStrings([
      ...(g.deny_patterns ?? []),
      ...(p.deny_patterns ?? []),
    ]),
    timeout_ms_default: p.timeout_ms_default ?? g.timeout_ms_default,
    timeout_ms_cap: p.timeout_ms_cap ?? g.timeout_ms_cap,
  };
}

function uniqueStrings(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const i of items) {
    const t = i?.trim();
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

/**
 * Evaluate whether a child agent may run this shell command.
 * Call only when spawnDepth > 0.
 */
export function evaluateSpawnShellPolicy(
  command: string,
  policy: SpawnShellPolicy | undefined,
  opts?: {
    cwd?: string;
    requestedTimeoutMs?: number;
    requestedMaxTimeoutMs?: number;
  },
): ShellPolicyVerdict {
  if (!policy) {
    return { ok: true };
  }

  const mode: SpawnShellMode = policy.mode ?? 'inherit';
  const normalized = stripLeadingCd(command, opts?.cwd);
  const denyHit = commandMatchesDeny(normalized, policy.deny_patterns);
  if (denyHit) {
    return {
      ok: false,
      reason: `run_shell blocked by spawn_shell_policy (deny): matched /${denyHit}/`,
    };
  }

  if (mode === 'allowlist') {
    const prefixes = policy.allowed_prefixes ?? [];
    if (prefixes.length === 0) {
      return {
        ok: false,
        reason:
          'run_shell blocked by spawn_shell_policy (allowlist): no allowed_prefixes configured',
      };
    }
    if (!commandMatchesAnyPrefix(normalized, prefixes)) {
      const sample = prefixes.slice(0, 5).join(', ');
      return {
        ok: false,
        reason: `run_shell blocked by spawn_shell_policy (allowlist): command does not match allowed_prefixes (e.g. ${sample})`,
      };
    }
  }

  // inherit / deny_only / allowlist-passed: apply timeout clamps
  let timeout_ms = opts?.requestedTimeoutMs;
  let max_timeout_ms = opts?.requestedMaxTimeoutMs;
  const def = policy.timeout_ms_default;
  const cap = policy.timeout_ms_cap;

  if (timeout_ms === undefined && def !== undefined) {
    timeout_ms = def;
  }
  if (cap !== undefined) {
    if (timeout_ms !== undefined) timeout_ms = Math.min(timeout_ms, cap);
    if (max_timeout_ms !== undefined) max_timeout_ms = Math.min(max_timeout_ms, cap);
    else if (timeout_ms !== undefined) max_timeout_ms = cap;
  }

  return { ok: true, timeout_ms, max_timeout_ms };
}

/** Default deny list shared by stress / coding children (safe baseline). */
export const DEFAULT_SPAWN_SHELL_DENY: string[] = [
  String.raw`\brm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+)?/`,
  String.raw`\bsudo\b`,
  String.raw`\bmkfs\b`,
  String.raw`curl\s+.*\|\s*(ba)?sh`,
  String.raw`wget\s+.*\|\s*(ba)?sh`,
  String.raw`>\s*/etc/`,
  String.raw`\bdd\s+if=`,
];

/** Sensible allowlist for dev-worker style agents. */
export const DEFAULT_DEV_WORKER_SHELL_ALLOW: string[] = [
  'npm test',
  'npm run',
  'npm ',
  'npx ',
  'node ',
  'git ',
  'tsc',
  'tsx ',
];
