import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const MEMORY_DIR_REL = '.agent/memory';

export type MemoryFileKey = 'profile' | 'archives' | 'requirements';

export const MEMORY_FILE_KEYS: MemoryFileKey[] = ['profile', 'archives', 'requirements'];

export const MEMORY_FILENAMES: Record<MemoryFileKey, string> = {
  profile: 'profile.md',
  archives: 'archives.md',
  requirements: 'requirements.md',
};

/** Files injected into the system prompt (archives are index-only). */
export const MEMORY_INJECT_KEYS: MemoryFileKey[] = ['profile', 'requirements'];

export const DEFAULT_MEMORY_INJECT_MAX_CHARS = 4_096;

export interface MemoryFileDoc {
  key: MemoryFileKey;
  path: string;
  relativePath: string;
  content: string;
  truncated: boolean;
}

export interface WorkspaceMemoryInjection {
  files: MemoryFileDoc[];
  combinedChars: number;
  truncated: boolean;
}

export interface LoadMemoryInjectOptions {
  maxChars?: number;
}

export type MemorySlashAction =
  | { type: 'status' }
  | { type: 'show'; file?: MemoryFileKey }
  | { type: 'init' }
  | { type: 'paths' };

function normalizeCwd(cwd: string): string {
  return resolve(cwd);
}

export function userMemoryDir(cwd: string): string {
  return resolve(normalizeCwd(cwd), MEMORY_DIR_REL);
}

export function userMemoryFilePath(cwd: string, key: MemoryFileKey): string {
  return resolve(userMemoryDir(cwd), MEMORY_FILENAMES[key]);
}

function relativeMemoryPath(key: MemoryFileKey): string {
  return `${MEMORY_DIR_REL}/${MEMORY_FILENAMES[key]}`;
}

function readMemoryFile(cwd: string, key: MemoryFileKey): string | null {
  const path = userMemoryFilePath(cwd, key);
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, 'utf8').trim();
    return raw || null;
  } catch {
    return null;
  }
}

function resolveInjectMaxChars(opts?: LoadMemoryInjectOptions): number {
  const fromEnv = process.env.MEMORY_INJECT_MAX_CHARS
    ? Number(process.env.MEMORY_INJECT_MAX_CHARS)
    : undefined;
  const max = opts?.maxChars ?? fromEnv ?? DEFAULT_MEMORY_INJECT_MAX_CHARS;
  return Number.isFinite(max) && max > 0 ? max : DEFAULT_MEMORY_INJECT_MAX_CHARS;
}

export function loadWorkspaceMemoryInjection(
  cwd: string,
  opts?: LoadMemoryInjectOptions,
): WorkspaceMemoryInjection | null {
  let remaining = resolveInjectMaxChars(opts);
  const files: MemoryFileDoc[] = [];
  let truncated = false;

  for (const key of MEMORY_INJECT_KEYS) {
    const raw = readMemoryFile(cwd, key);
    if (!raw) continue;

    const slice = raw.length > remaining;
    const content = slice ? raw.slice(0, remaining) : raw;
    if (slice) truncated = true;
    remaining = Math.max(0, remaining - content.length);

    files.push({
      key,
      path: userMemoryFilePath(cwd, key),
      relativePath: relativeMemoryPath(key),
      content,
      truncated: slice,
    });

    if (remaining <= 0) break;
  }

  if (files.length === 0) return null;

  return {
    files,
    combinedChars: files.reduce((n, f) => n + f.content.length, 0),
    truncated,
  };
}

export function formatWorkspaceMemoryBlock(injection: WorkspaceMemoryInjection): string {
  const parts = injection.files.map((file) => {
    const title =
      file.key === 'profile'
        ? 'User profile'
        : file.key === 'requirements'
          ? 'User requirements'
          : file.key;
    const trunc = file.truncated ? ' _(truncated)_' : '';
    return `### ${title}\nSource: ${file.relativePath}${trunc}\n\n${file.content}`;
  });
  const tail = injection.truncated
    ? '\n\n_(Cross-session memory truncated; use read_file on .agent/memory/ for full text.)_'
    : '';
  return `\n\n## Cross-session memory\n${parts.join('\n\n')}${tail}`;
}

export function workspaceMemoryRunMeta(
  injection: WorkspaceMemoryInjection,
): { profile_chars: number; requirements_chars: number; truncated: boolean } {
  const profile = injection.files.find((f) => f.key === 'profile');
  const requirements = injection.files.find((f) => f.key === 'requirements');
  return {
    profile_chars: profile?.content.length ?? 0,
    requirements_chars: requirements?.content.length ?? 0,
    truncated: injection.truncated,
  };
}

const MEMORY_TEMPLATES: Record<MemoryFileKey, string> = {
  profile: `# User profile

<!-- Preferences, role, communication style, stack familiarity -->
`,
  archives: `# Task archives

<!-- One line per major completed task: YYYY-MM-DD | path or topic | one-line summary -->
`,
  requirements: `# Requirements

<!-- Hard rules the agent must follow across sessions -->
`,
};

export function ensureUserMemoryDir(cwd: string): string {
  const dir = userMemoryDir(cwd);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}

export function initUserMemoryFiles(cwd: string): string[] {
  ensureUserMemoryDir(cwd);
  const created: string[] = [];
  for (const key of MEMORY_FILE_KEYS) {
    const path = userMemoryFilePath(cwd, key);
    if (existsSync(path)) continue;
    writeFileSync(path, MEMORY_TEMPLATES[key], 'utf8');
    created.push(relativeMemoryPath(key));
  }
  return created;
}

export function memoryFileStatus(cwd: string): Array<{
  key: MemoryFileKey;
  relativePath: string;
  exists: boolean;
  chars: number;
}> {
  return MEMORY_FILE_KEYS.map((key) => {
    const path = userMemoryFilePath(cwd, key);
    const exists = existsSync(path);
    let chars = 0;
    if (exists) {
      try {
        chars = readFileSync(path, 'utf8').trim().length;
      } catch {
        chars = 0;
      }
    }
    return { key, relativePath: relativeMemoryPath(key), exists, chars };
  });
}

function parseMemoryFileKey(raw: string | undefined): MemoryFileKey | null {
  if (!raw) return null;
  const key = raw.toLowerCase();
  if (key === 'profile' || key === 'archives' || key === 'requirements') {
    return key;
  }
  return null;
}

export function parseMemorySlash(parts: string[]): MemorySlashAction | string {
  const sub = parts[1]?.toLowerCase();

  if (!sub) return { type: 'status' };

  switch (sub) {
    case 'show': {
      const file = parseMemoryFileKey(parts[2]);
      if (parts[2] && !file) {
        return 'Usage: /memory show profile|archives|requirements';
      }
      return { type: 'show', file: file ?? undefined };
    }
    case 'init':
      return { type: 'init' };
    case 'paths':
      return { type: 'paths' };
    default:
      return 'Usage: /memory [show profile|archives|requirements|init|paths]';
  }
}

export function executeMemorySlash(cwd: string, action: MemorySlashAction): string {
  switch (action.type) {
    case 'init': {
      const created = initUserMemoryFiles(cwd);
      if (created.length === 0) {
        return 'Memory files already exist (.agent/memory/). Use /memory show to view.';
      }
      return `Created:\n${created.map((p) => `  ${p}`).join('\n')}`;
    }
    case 'paths': {
      const dir = userMemoryDir(cwd);
      return MEMORY_FILE_KEYS.map(
        (key) => `  ${relativeMemoryPath(key)}\n    ${userMemoryFilePath(cwd, key)}`,
      ).join('\n') + `\n  dir: ${dir}`;
    }
    case 'show': {
      if (action.file) {
        const content = readMemoryFile(cwd, action.file);
        if (content === null) {
          return `(${relativeMemoryPath(action.file)} missing — /memory init)`;
        }
        const header = `--- ${relativeMemoryPath(action.file)} ---`;
        const shown = content.length > 4000 ? `${content.slice(0, 4000)}\n…(truncated display)` : content;
        return `${header}\n${shown}`;
      }
      const blocks: string[] = [];
      for (const key of MEMORY_FILE_KEYS) {
        const content = readMemoryFile(cwd, key);
        blocks.push(
          content === null
            ? `${relativeMemoryPath(key)}: (missing)`
            : `${relativeMemoryPath(key)} (${content.length} chars):\n${content.length > 1200 ? `${content.slice(0, 1200)}\n…` : content}`,
        );
      }
      return blocks.join('\n\n');
    }
    case 'status':
    default: {
      const rows = memoryFileStatus(cwd);
      const lines = rows.map((r) => {
        const state = r.exists ? `${r.chars} chars` : 'missing';
        const inject = MEMORY_INJECT_KEYS.includes(r.key) ? ', injected' : ', index only';
        return `  ${r.relativePath}: ${state}${r.exists ? inject : ''}`;
      });
      const injection = loadWorkspaceMemoryInjection(cwd);
      const injectNote = injection
        ? `\nInjected this run: profile ${injection.files.find((f) => f.key === 'profile')?.content.length ?? 0} + requirements ${injection.files.find((f) => f.key === 'requirements')?.content.length ?? 0} chars${injection.truncated ? ' (truncated)' : ''}`
        : '\nInjected this run: (none)';
      return `Cross-session memory (.agent/memory/):\n${lines.join('\n')}${injectNote}\n\n/memory init — create templates · /memory show [file] · /memory paths`;
    }
  }
}