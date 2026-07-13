/**
 * C1: thin git wrappers — structured argv spawn (no shell string).
 * Permission: same shell gate as run_shell (allowShell / JIT).
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import type { AgentConfig, ToolDefinition } from '../types.js';
import { pathWouldEscape, resolveSafePath } from './path-utils.js';

const DEFAULT_MAX_CHARS = 80_000;
const MAX_MAX_CHARS = 200_000;
const DEFAULT_LOG_COUNT = 15;
const MAX_LOG_COUNT = 50;
const GIT_TIMEOUT_MS = 30_000;

export const GIT_DEFINITIONS: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'git_status',
      description:
        'Show git working tree status (short format). Prefer this over free-form run_shell for status. Requires shell permission. Fails if cwd is not a git repo.',
      parameters: {
        type: 'object',
        properties: {
          branch: {
            type: 'boolean',
            description: 'Include branch info (-b). Default true.',
          },
          untracked: {
            type: 'boolean',
            description: 'Show untracked files. Default true.',
          },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'git_diff',
      description:
        'Show git diff (unstaged by default, or staged). Prefer over run_shell for reading diffs. Requires shell permission. Optional path relative to cwd.',
      parameters: {
        type: 'object',
        properties: {
          staged: {
            type: 'boolean',
            description: 'If true, git diff --cached (staged). Default false.',
          },
          path: {
            type: 'string',
            description: 'Limit to path relative to cwd (must stay under cwd).',
          },
          max_chars: {
            type: 'number',
            description: `Truncate output after this many chars (default ${DEFAULT_MAX_CHARS}).`,
          },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'git_log',
      description:
        'Show recent git commits (oneline). Requires shell permission. Optional path filter under cwd.',
      parameters: {
        type: 'object',
        properties: {
          max_count: {
            type: 'number',
            description: `Number of commits (default ${DEFAULT_LOG_COUNT}, max ${MAX_LOG_COUNT}).`,
          },
          path: {
            type: 'string',
            description: 'Limit history to path under cwd.',
          },
          max_chars: {
            type: 'number',
            description: `Truncate output after this many chars (default ${DEFAULT_MAX_CHARS}).`,
          },
        },
      },
    },
  },
];

export const GIT_TOOL_NAMES = ['git_status', 'git_diff', 'git_log'] as const;

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = value === undefined ? fallback : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

function isGitRepo(cwd: string): boolean {
  return existsSync(resolve(cwd, '.git'));
}

function resolveOptionalPath(cwd: string, pathArg: unknown): string | { error: string } {
  if (pathArg === undefined || pathArg === null || pathArg === '') return '';
  const input = String(pathArg).trim();
  if (!input) return '';
  if (pathWouldEscape(cwd, input)) {
    return { error: `error: path escapes working directory: ${input}` };
  }
  try {
    // Prefer path relative to cwd for git pathspecs.
    const abs = resolveSafePath(cwd, input);
    const rel = abs === resolve(cwd) ? '.' : abs.slice(resolve(cwd).length + 1);
    return rel || '.';
  } catch (err) {
    return { error: `error: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export function buildGitStatusArgs(args: Record<string, unknown>): string[] {
  const branch = args.branch !== false;
  const untracked = args.untracked !== false;
  const argv = ['status', '--short'];
  if (branch) argv.push('-b');
  if (!untracked) argv.push('-uno');
  return argv;
}

export function buildGitDiffArgs(
  cwd: string,
  args: Record<string, unknown>,
): string[] | { error: string } {
  const staged = args.staged === true;
  const pathRes = resolveOptionalPath(cwd, args.path);
  if (typeof pathRes === 'object') return pathRes;

  const argv = ['diff', '--no-ext-diff', '--no-color'];
  if (staged) argv.push('--cached');
  if (pathRes) {
    argv.push('--', pathRes);
  }
  return argv;
}

export function buildGitLogArgs(
  cwd: string,
  args: Record<string, unknown>,
): string[] | { error: string } {
  const maxCount = clampInt(args.max_count, DEFAULT_LOG_COUNT, 1, MAX_LOG_COUNT);
  const pathRes = resolveOptionalPath(cwd, args.path);
  if (typeof pathRes === 'object') return pathRes;

  const argv = [
    'log',
    `--max-count=${maxCount}`,
    '--oneline',
    '--decorate',
    '--no-color',
  ];
  if (pathRes) {
    argv.push('--', pathRes);
  }
  return argv;
}

export function truncateGitOutput(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n\n… [truncated at ${maxChars} chars; narrow path or use run_shell for full output]`;
}

export async function runGitArgv(
  cwd: string,
  gitArgs: string[],
  opts?: { abortSignal?: AbortSignal; timeoutMs?: number },
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const timeoutMs = opts?.timeoutMs ?? GIT_TIMEOUT_MS;
  const abortSignal = opts?.abortSignal;

  return new Promise((resolvePromise) => {
    if (abortSignal?.aborted) {
      resolvePromise({ code: null, stdout: '', stderr: 'aborted' });
      return;
    }

    const child = spawn('git', gitArgs, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, GIT_PAGER: 'cat', GIT_TERMINAL_PROMPT: '0' },
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const finish = (code: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      abortSignal?.removeEventListener('abort', onAbort);
      resolvePromise({ code, stdout, stderr });
    };

    const onAbort = (): void => {
      child.kill('SIGTERM');
      finish(null);
    };
    abortSignal?.addEventListener('abort', onAbort, { once: true });

    const timer = setTimeout(() => {
      stderr = stderr
        ? `${stderr}\nerror: git timed out after ${timeoutMs}ms`
        : `error: git timed out after ${timeoutMs}ms`;
      child.kill('SIGTERM');
      finish(null);
    }, timeoutMs);

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', (err) => {
      stderr = err.message;
      finish(null);
    });
    child.on('close', (code) => finish(code));
  });
}

function formatGitResult(
  tool: string,
  argv: string[],
  result: { code: number | null; stdout: string; stderr: string },
  maxChars: number,
): string {
  if (result.code === null && result.stderr.includes('aborted')) {
    return '[aborted]';
  }
  if (result.code === null && result.stderr.includes('timed out')) {
    return result.stderr.trim().startsWith('error:')
      ? result.stderr.trim()
      : `error: ${result.stderr.trim()}`;
  }
  if (result.stderr.includes('ENOENT') || /spawn git ENOENT/i.test(result.stderr)) {
    return 'error: git not found on PATH';
  }

  const body = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
  if (result.code !== 0 && result.code !== null) {
    const msg = body || `git exited ${result.code}`;
    return truncateGitOutput(`error: git ${argv.join(' ')} failed (exit ${result.code})\n${msg}`, maxChars);
  }

  if (!body) {
    return tool === 'git_status'
      ? 'ok: clean working tree (no short status lines)'
      : tool === 'git_diff'
        ? 'ok: no differences'
        : 'ok: (empty log)';
  }

  return truncateGitOutput(body, maxChars);
}

export async function runGitTool(
  toolName: string,
  args: Record<string, unknown>,
  config: AgentConfig,
): Promise<string | null> {
  if (toolName !== 'git_status' && toolName !== 'git_diff' && toolName !== 'git_log') {
    return null;
  }

  if (!isGitRepo(config.cwd)) {
    return 'error: not a git repository (no .git in cwd). Initialize git or set --cwd to a repo root.';
  }

  const maxChars = clampInt(args.max_chars, DEFAULT_MAX_CHARS, 1_000, MAX_MAX_CHARS);

  let gitArgs: string[];
  if (toolName === 'git_status') {
    gitArgs = buildGitStatusArgs(args);
  } else if (toolName === 'git_diff') {
    const built = buildGitDiffArgs(config.cwd, args);
    if ('error' in built) return built.error;
    gitArgs = built;
  } else {
    const built = buildGitLogArgs(config.cwd, args);
    if ('error' in built) return built.error;
    gitArgs = built;
  }

  const result = await runGitArgv(config.cwd, gitArgs, {
    abortSignal: config.abortSignal,
  });
  return formatGitResult(toolName, gitArgs, result, maxChars);
}
