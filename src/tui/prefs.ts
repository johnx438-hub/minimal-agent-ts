import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';

export interface TuiPrefs {
  allowShell: boolean;
  allowWeb: boolean;
  /** L3: persist shell approval across sessions (startup warning). */
  alwaysShell?: boolean;
  /** L3: persist web approval across sessions (startup warning). */
  alwaysWeb?: boolean;
  /** Show [turn N] lines (default false — SPEC_TUI_POLISH TUI-B). */
  verbose_turns?: boolean;
  /** Show every action_flush / turn_io when metrics on (default false). */
  verbose_io?: boolean;
  /** Multi-line run_start details (default false). */
  verbose_run_header?: boolean;
  /** Full shell bodies without height cap (default false). */
  verbose_tools?: boolean;
}

const DEFAULT_PREFS: TuiPrefs = {
  allowShell: true,
  allowWeb: false,
  alwaysShell: false,
  alwaysWeb: false,
  verbose_turns: false,
  verbose_io: false,
  verbose_run_header: false,
  verbose_tools: false,
};

function localPrefsPath(root: string): string {
  return resolve(root, '.tui-prefs.json');
}

function globalPrefsPath(): string {
  return resolve(homedir(), '.config', 'minimal-agent-ts', 'tui-prefs.json');
}

const PREFS_WALK_MAX = 12;

/**
 * Project root for .tui-prefs.json: nearest ancestor with an existing prefs file,
 * else nearest ancestor with agent.json, else startCwd.
 */
export function resolvePrefsRoot(startCwd: string): string {
  let dir = resolve(startCwd);

  for (let i = 0; i < PREFS_WALK_MAX; i++) {
    if (existsSync(localPrefsPath(dir))) return dir;
    const parent = resolve(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }

  dir = resolve(startCwd);
  for (let i = 0; i < PREFS_WALK_MAX; i++) {
    if (existsSync(resolve(dir, 'agent.json'))) return dir;
    const parent = resolve(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }

  return resolve(startCwd);
}

export function prefsPath(cwd: string): string {
  const root = resolvePrefsRoot(cwd);
  const local = localPrefsPath(root);
  if (existsSync(local)) return local;
  return globalPrefsPath();
}

function parseBool(v: unknown, fallback: boolean): boolean {
  if (typeof v === 'boolean') return v;
  return fallback;
}

export function loadPrefs(cwd: string): TuiPrefs | null {
  const root = resolvePrefsRoot(cwd);
  const local = localPrefsPath(root);
  const path = existsSync(local) ? local : globalPrefsPath();
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<TuiPrefs>;
    return {
      allowShell: parseBool(raw.allowShell, DEFAULT_PREFS.allowShell),
      allowWeb: parseBool(raw.allowWeb, DEFAULT_PREFS.allowWeb),
      alwaysShell: parseBool(raw.alwaysShell, false),
      alwaysWeb: parseBool(raw.alwaysWeb, false),
      verbose_turns: parseBool(raw.verbose_turns, false),
      verbose_io: parseBool(raw.verbose_io, false),
      verbose_run_header: parseBool(raw.verbose_run_header, false),
      verbose_tools: parseBool(raw.verbose_tools, false),
    };
  } catch {
    return null;
  }
}

export function savePrefs(cwd: string, prefs: TuiPrefs): void {
  const root = resolvePrefsRoot(cwd);
  const path = localPrefsPath(root);
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(path, JSON.stringify(prefs, null, 2), 'utf8');
}

export function defaultPrefs(): TuiPrefs {
  return { ...DEFAULT_PREFS };
}

/** always* flags imply matching allow* switches in persisted prefs. */
export function normalizePrefs(prefs: TuiPrefs): TuiPrefs {
  const out = { ...prefs };
  if (out.alwaysShell) out.allowShell = true;
  if (out.alwaysWeb) out.allowWeb = true;
  return out;
}

/**
 * Apply TUI_VERBOSE=1 → all verbose_* true (debug override, not persisted).
 */
export function applyVerboseEnv(prefs: TuiPrefs): TuiPrefs {
  if (process.env.TUI_VERBOSE?.trim() !== '1') return prefs;
  return {
    ...prefs,
    verbose_turns: true,
    verbose_io: true,
    verbose_run_header: true,
    verbose_tools: true,
  };
}

/** Merge partial prefs with saved (or defaults) and persist. */
export function mergePrefs(cwd: string, patch: Partial<TuiPrefs>): TuiPrefs {
  const current = loadPrefs(cwd) ?? defaultPrefs();
  const merged = normalizePrefs({ ...current, ...patch });
  savePrefs(cwd, merged);
  return merged;
}

export function formatApproveStatus(prefs: TuiPrefs): string {
  const lines = [
    `shell: ${prefs.allowShell ? 'on' : 'off'}${prefs.alwaysShell ? ' (always)' : ''}`,
    `web:   ${prefs.allowWeb ? 'on' : 'off'}${prefs.alwaysWeb ? ' (always)' : ''}`,
  ];
  return lines.join('\n');
}

/** Display prefs snapshot for /status-style diagnostics. */
export function formatVerbosePrefs(prefs: TuiPrefs): string {
  return [
    `verbose_turns: ${prefs.verbose_turns ? 'on' : 'off'}`,
    `verbose_io: ${prefs.verbose_io ? 'on' : 'off'}`,
    `verbose_run_header: ${prefs.verbose_run_header ? 'on' : 'off'}`,
    `verbose_tools: ${prefs.verbose_tools ? 'on' : 'off'}`,
  ].join('\n');
}
