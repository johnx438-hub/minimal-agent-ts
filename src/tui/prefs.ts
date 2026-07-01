import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';

export interface TuiPrefs {
  allowShell: boolean;
  allowWeb: boolean;
}

const DEFAULT_PREFS: TuiPrefs = {
  allowShell: true,
  allowWeb: false,
};

function localPrefsPath(cwd: string): string {
  return resolve(cwd, '.tui-prefs.json');
}

function globalPrefsPath(): string {
  return resolve(homedir(), '.config', 'minimal-agent-ts', 'tui-prefs.json');
}

export function prefsPath(cwd: string): string {
  const local = localPrefsPath(cwd);
  if (existsSync(local)) return local;
  return globalPrefsPath();
}

export function loadPrefs(cwd: string): TuiPrefs | null {
  const local = localPrefsPath(cwd);
  const path = existsSync(local) ? local : globalPrefsPath();
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<TuiPrefs>;
    return {
      allowShell: raw.allowShell ?? DEFAULT_PREFS.allowShell,
      allowWeb: raw.allowWeb ?? DEFAULT_PREFS.allowWeb,
    };
  } catch {
    return null;
  }
}

export function savePrefs(cwd: string, prefs: TuiPrefs): void {
  const path = localPrefsPath(cwd);
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(path, JSON.stringify(prefs, null, 2), 'utf8');
}

export function defaultPrefs(): TuiPrefs {
  return { ...DEFAULT_PREFS };
}