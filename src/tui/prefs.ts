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
}

const DEFAULT_PREFS: TuiPrefs = {
  allowShell: true,
  allowWeb: false,
  alwaysShell: false,
  alwaysWeb: false,
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

export function loadPrefs(cwd: string): TuiPrefs | null {
  const root = resolvePrefsRoot(cwd);
  const local = localPrefsPath(root);
  const path = existsSync(local) ? local : globalPrefsPath();
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<TuiPrefs>;
    return {
      allowShell: raw.allowShell ?? DEFAULT_PREFS.allowShell,
      allowWeb: raw.allowWeb ?? DEFAULT_PREFS.allowWeb,
      alwaysShell: raw.alwaysShell ?? false,
      alwaysWeb: raw.alwaysWeb ?? false,
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