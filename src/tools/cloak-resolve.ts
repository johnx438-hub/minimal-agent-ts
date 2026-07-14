/**
 * Portable cloak_fetch / CloakBrowser discovery (Linux, macOS, Win, Git Bash).
 * Prefer env + agent.json; auto paths are best-effort hints only — no WSL-only absolutes.
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';

export function expandUserPath(path: string, cwd = process.cwd()): string {
  const t = path.trim();
  if (!t) return t;
  if (t === '~') return homedir();
  if (t.startsWith('~/') || t.startsWith('~\\')) {
    return resolve(homedir(), t.slice(2));
  }
  if (isAbsolute(t)) return t;
  return resolve(cwd, t);
}

/**
 * Candidate script paths in priority order (may not exist).
 * Configured path and CLOAK_FETCH_SCRIPT win; then in-repo skill; then home hints.
 */
export function cloakScriptCandidates(opts?: {
  configured?: string;
  cwd?: string;
}): string[] {
  const cwd = opts?.cwd ?? process.cwd();
  const home = homedir();
  const raw = [
    opts?.configured?.trim(),
    process.env.CLOAK_FETCH_SCRIPT?.trim(),
    // In-repo skill (works on Win + Git Bash when cwd is project root)
    'skills/cloak-fetch/cloak_fetch.py',
    'skills/cloak-fetch/cloak_fetch.sh',
    // Claude / editor skill layouts under user home (homedir() is portable)
    resolve(home, '.claude/skills/cloak-fetch/cloak_fetch.py'),
    resolve(home, '.claude/skills/cloak-fetch/cloak_fetch.sh'),
    resolve(home, '.claude/hooks/cloak_fetch.py'),
    // Common clone locations (Unix-style under $HOME — still valid on Git Bash)
    resolve(home, 'github/cloakFetch/skills/cloak-fetch/cloak_fetch.py'),
    resolve(home, 'github/cloakFetch/skills/cloak-fetch/cloak_fetch.sh'),
    // Windows-ish clone locations under user profile
    resolve(home, 'source/repos/cloakFetch/skills/cloak-fetch/cloak_fetch.py'),
    resolve(home, 'Documents/GitHub/cloakFetch/skills/cloak-fetch/cloak_fetch.py'),
    resolve(home, 'Documents/GitHub/cloakFetch/skills/cloak-fetch/cloak_fetch.sh'),
  ].filter((c): c is string => Boolean(c));

  const out: string[] = [];
  const seen = new Set<string>();
  for (const c of raw) {
    const abs = expandUserPath(c, cwd);
    if (seen.has(abs)) continue;
    seen.add(abs);
    out.push(abs);
  }
  return out;
}

/** First existing cloak_fetch script, or undefined. */
export function discoverCloakScript(opts?: {
  configured?: string;
  cwd?: string;
}): string | undefined {
  for (const path of cloakScriptCandidates(opts)) {
    if (existsSync(path)) return path;
  }
  return undefined;
}

function commandLooksAvailable(command: string): boolean {
  try {
    const result = spawnSync(command, ['--version'], {
      stdio: 'ignore',
      timeout: 3_000,
      windowsHide: true,
    });
    if (result.error) {
      const code = (result.error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return false;
    }
    // Present even if --version fails (some Windows shims)
    return result.status !== null || !result.error;
  } catch {
    return false;
  }
}

/**
 * Python interpreter for cloak_fetch.py.
 * Prefers configured path / CLOAKBROWSER_PYTHON, then venv (Unix + Windows),
 * then PATH: python3 → python → py.
 */
export function resolveCloakPython(configured?: string, cwd = process.cwd()): string {
  const home = homedir();
  const pathCandidates = [
    configured?.trim(),
    process.env.CLOAKBROWSER_PYTHON?.trim(),
    // Unix venv
    resolve(home, 'github/CloakBrowser/.venv/bin/python'),
    resolve(home, 'github/CloakBrowser/.venv/bin/python3'),
    // Windows venv
    resolve(home, 'github/CloakBrowser/.venv/Scripts/python.exe'),
    resolve(home, 'github/CloakBrowser/.venv/Scripts/python'),
    resolve(home, 'source/repos/CloakBrowser/.venv/Scripts/python.exe'),
  ].filter((c): c is string => Boolean(c));

  for (const c of pathCandidates) {
    const abs = expandUserPath(c, cwd);
    if (existsSync(abs)) return abs;
  }

  const pathCmds =
    process.platform === 'win32'
      ? ['python', 'py', 'python3']
      : ['python3', 'python', 'py'];
  for (const cmd of pathCmds) {
    if (commandLooksAvailable(cmd)) return cmd;
  }

  return process.platform === 'win32' ? 'python' : 'python3';
}

/**
 * ddgr has no absolute auto-path: only PATH or agent.json web_search.ddgr_path.
 * On Windows try common shim names after the configured / default name.
 */
export function ddgrCommandCandidates(configured?: string): string[] {
  const primary = configured?.trim() || process.env.DDGR_PATH?.trim() || 'ddgr';
  const extras =
    process.platform === 'win32'
      ? ['ddgr.exe', 'ddgr.cmd', 'ddgr.bat']
      : [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const c of [primary, ...extras]) {
    if (!c || seen.has(c)) continue;
    seen.add(c);
    out.push(c);
  }
  return out;
}

/** First ddgr command that spawns, or the primary name for error messages. */
export function resolveDdgrCommand(configured?: string): {
  command: string;
  available: boolean;
} {
  const candidates = ddgrCommandCandidates(configured);
  for (const cmd of candidates) {
    if (cmd.includes('/') || cmd.includes('\\') || cmd.includes(':')) {
      const abs = expandUserPath(cmd);
      if (existsSync(abs)) return { command: abs, available: true };
      continue;
    }
    if (commandLooksAvailable(cmd)) return { command: cmd, available: true };
  }
  return { command: candidates[0] ?? 'ddgr', available: false };
}
