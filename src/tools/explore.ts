import { spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { isAbortError } from '../events.js';
import { loadAction } from '../action-store.js';
import type { AgentConfig, ToolDefinition } from '../types.js';
import { resolveReadablePath } from './path-utils.js';

const GREP_TIMEOUT_MS = 30_000;
const MAX_BUFFER_BYTES = 1024 * 1024;

function abortedOutput(signal?: AbortSignal): string | null {
  return signal?.aborted ? '[aborted]' : null;
}

interface ExecResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

function execFileAbortable(
  command: string,
  args: string[],
  opts: {
    cwd?: string;
    timeoutMs: number;
    abortSignal?: AbortSignal;
  },
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    if (opts.abortSignal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }

    const child = spawn(command, args, {
      cwd: opts.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const finish = (result: ExecResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.abortSignal?.removeEventListener('abort', onAbort);
      resolve(result);
    };

    const fail = (err: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.abortSignal?.removeEventListener('abort', onAbort);
      if (child.exitCode === null) child.kill('SIGTERM');
      reject(err);
    };

    const onAbort = (): void => {
      if (child.exitCode === null) child.kill('SIGTERM');
      fail(new DOMException('Aborted', 'AbortError'));
    };
    opts.abortSignal?.addEventListener('abort', onAbort, { once: true });

    const timer = setTimeout(() => {
      if (child.exitCode === null) child.kill('SIGTERM');
      fail(new Error(`command timed out after ${opts.timeoutMs}ms`));
    }, opts.timeoutMs);

    const append = (chunk: Buffer, target: 'stdout' | 'stderr'): void => {
      const text = chunk.toString();
      const next = (target === 'stdout' ? stdout : stderr) + text;
      if (Buffer.byteLength(next, 'utf8') > MAX_BUFFER_BYTES) {
        fail(new Error(`output exceeded ${MAX_BUFFER_BYTES} bytes`));
        return;
      }
      if (target === 'stdout') stdout = next;
      else stderr = next;
    };

    child.stdout?.on('data', (chunk: Buffer) => append(chunk, 'stdout'));
    child.stderr?.on('data', (chunk: Buffer) => append(chunk, 'stderr'));
    child.on('error', (err) => fail(err));
    child.on('close', (code) => finish({ stdout, stderr, code }));
  });
}

export const EXPLORE_DEFINITIONS: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'grep_search',
      description: 'Search for a regex pattern in project files (ripgrep preferred).',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Regex pattern' },
          path: { type: 'string', description: 'Directory or file to search (default: cwd)' },
          glob: { type: 'string', description: 'File glob filter, e.g. *.ts' },
          context_lines: { type: 'integer', description: 'Lines of context around matches' },
          max_matches: { type: 'integer', description: 'Max matches to return (default 50)' },
        },
        required: ['pattern'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_files',
      description: 'List files under a directory as an indented tree.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Directory path (default: cwd root ".")' },
          max_depth: { type: 'integer', description: 'Max recursion depth (default 3)' },
          include_hidden: { type: 'boolean', description: 'Include dotfiles' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'diff_file',
      description:
        'Unified diff between a file now and a prior snapshot (before_action_id from ActionStore).',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path' },
          before_action_id: { type: 'string', description: 'Prior action_id (read_file / write_file)' },
          before_text: { type: 'string', description: 'Optional explicit before content' },
        },
        required: ['path'],
      },
    },
  },
];

async function grepSearch(args: Record<string, unknown>, config: AgentConfig): Promise<string> {
  const aborted = abortedOutput(config.abortSignal);
  if (aborted) return aborted;

  const pattern = String(args.pattern ?? '');
  const rel = String(args.path ?? '.');
  let searchPath: string;
  try {
    searchPath = await resolveReadablePath(config, rel, `grep_search: ${rel}`);
  } catch (err) {
    if (isAbortError(err) || config.abortSignal?.aborted) return '[aborted]';
    const msg = err instanceof Error ? err.message : String(err);
    return `error: ${msg}`;
  }
  const glob = args.glob ? String(args.glob) : undefined;
  const context = args.context_lines === undefined ? 0 : Number(args.context_lines);
  const maxMatches = args.max_matches === undefined ? 50 : Number(args.max_matches);
  const execOpts = {
    cwd: config.cwd,
    timeoutMs: GREP_TIMEOUT_MS,
    abortSignal: config.abortSignal,
  };

  const rgArgs = ['--no-heading', '--line-number', '-m', String(maxMatches)];
  if (context > 0) rgArgs.push('-C', String(context));
  if (glob) rgArgs.push('--glob', glob);
  rgArgs.push(pattern, searchPath);

  try {
    const { stdout, code } = await execFileAbortable('rg', rgArgs, execOpts);
    if (code === 1) return '(no matches)';
    const out = stdout.trim();
    return out || '(no matches)';
  } catch (err) {
    if (isAbortError(err) || config.abortSignal?.aborted) return '[aborted]';
    // fallback grep
    const grepArgs = ['-rn', pattern, searchPath];
    try {
      const { stdout, code } = await execFileAbortable('grep', grepArgs, execOpts);
      if (code === 1) return '(no matches)';
      const lines = stdout.trim().split('\n').slice(0, maxMatches);
      return lines.join('\n') || '(no matches)';
    } catch (grepErr) {
      if (isAbortError(grepErr) || config.abortSignal?.aborted) return '[aborted]';
      const msg = err instanceof Error ? err.message : String(err);
      return `error: grep failed: ${msg}`;
    }
  }
}

async function listTree(
  dir: string,
  prefix: string,
  depth: number,
  maxDepth: number,
  includeHidden: boolean,
  lines: string[],
  abortSignal?: AbortSignal,
): Promise<void> {
  if (abortSignal?.aborted) {
    throw new DOMException('Aborted', 'AbortError');
  }
  if (depth > maxDepth) return;

  const entries = await readdir(dir, { withFileTypes: true });
  const sorted = entries.sort((a, b) => a.name.localeCompare(b.name));

  for (const entry of sorted) {
    if (abortSignal?.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }
    if (!includeHidden && entry.name.startsWith('.')) continue;
    if (entry.name === 'node_modules') continue;

    lines.push(`${prefix}${entry.name}${entry.isDirectory() ? '/' : ''}`);
    if (entry.isDirectory()) {
      await listTree(
        join(dir, entry.name),
        `${prefix}  `,
        depth + 1,
        maxDepth,
        includeHidden,
        lines,
        abortSignal,
      );
    }
  }
}

async function listFiles(args: Record<string, unknown>, config: AgentConfig): Promise<string> {
  const aborted = abortedOutput(config.abortSignal);
  if (aborted) return aborted;

  const rel = String(args.path ?? '.');
  let dir: string;
  try {
    dir = await resolveReadablePath(config, rel, `list_files: ${rel}`);
  } catch (err) {
    if (isAbortError(err) || config.abortSignal?.aborted) return '[aborted]';
    const msg = err instanceof Error ? err.message : String(err);
    return `error: ${msg}`;
  }
  const maxDepth = args.max_depth === undefined ? 3 : Number(args.max_depth);
  const includeHidden = args.include_hidden === true;

  try {
    const lines: string[] = [`${rel}/`];
    await listTree(dir, '  ', 1, maxDepth, includeHidden, lines, config.abortSignal);
    return lines.join('\n');
  } catch (err) {
    if (isAbortError(err) || config.abortSignal?.aborted) return '[aborted]';
    throw err;
  }
}

function resolveBeforeText(
  beforeActionId: string | undefined,
  beforeText: string | undefined,
): string | null {
  if (beforeText !== undefined) return beforeText;
  if (!beforeActionId) return null;

  const action = loadAction(beforeActionId);
  if (!action) return null;

  if (action.tool_name === 'write_file') {
    try {
      const args = JSON.parse(action.args_json) as Record<string, unknown>;
      if (typeof args.content === 'string') return args.content;
    } catch {
      /* fall through */
    }
  }

  return action.result_text;
}

async function unifiedDiff(
  before: string,
  after: string,
  label: string,
  abortSignal?: AbortSignal,
): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ma-diff-'));
  const beforePath = join(dir, 'before');
  const afterPath = join(dir, 'after');
  try {
    await writeFile(beforePath, before, 'utf8');
    await writeFile(afterPath, after, 'utf8');
    const { stdout, code } = await execFileAbortable(
      'diff',
      ['-u', '--label', `${label} (before)`, '--label', `${label} (after)`, beforePath, afterPath],
      { timeoutMs: GREP_TIMEOUT_MS, abortSignal },
    );
    if (code === 0) return '(no differences)';
    if (code === 1) return stdout.trim() || '(no differences)';
    return `error: diff failed (exit ${code ?? 'null'})`;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function diffFile(args: Record<string, unknown>, config: AgentConfig): Promise<string> {
  const aborted = abortedOutput(config.abortSignal);
  if (aborted) return aborted;

  const path = String(args.path ?? '');
  let file: string;
  try {
    file = await resolveReadablePath(config, path, `diff_file: ${path}`);
  } catch (err) {
    if (isAbortError(err) || config.abortSignal?.aborted) return '[aborted]';
    const msg = err instanceof Error ? err.message : String(err);
    return `error: ${msg}`;
  }
  const after = await readFile(file, 'utf8');

  const before =
    resolveBeforeText(
      args.before_action_id ? String(args.before_action_id) : undefined,
      args.before_text !== undefined ? String(args.before_text) : undefined,
    ) ?? '';

  try {
    const diff = await unifiedDiff(before, after, path, config.abortSignal);
    const max = 8000;
    return diff.length > max ? `${diff.slice(0, max)}\n...(truncated)` : diff;
  } catch (err) {
    if (isAbortError(err) || config.abortSignal?.aborted) return '[aborted]';
    throw err;
  }
}

export async function runExploreTool(
  name: string,
  args: Record<string, unknown>,
  config: AgentConfig,
): Promise<string | null> {
  switch (name) {
    case 'grep_search':
      return grepSearch(args, config);
    case 'list_files':
      return listFiles(args, config);
    case 'diff_file':
      return diffFile(args, config);
    default:
      return null;
  }
}