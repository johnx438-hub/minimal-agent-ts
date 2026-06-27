import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { loadAction } from '../action-store.js';
import type { AgentConfig, ToolDefinition } from '../types.js';
import { resolveSafePath } from './path-utils.js';

const execFileAsync = promisify(execFile);

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
  const pattern = String(args.pattern ?? '');
  const rel = String(args.path ?? '.');
  const searchPath = resolveSafePath(config.cwd, rel);
  const glob = args.glob ? String(args.glob) : undefined;
  const context = args.context_lines === undefined ? 0 : Number(args.context_lines);
  const maxMatches = args.max_matches === undefined ? 50 : Number(args.max_matches);

  const rgArgs = ['--no-heading', '--line-number', '-m', String(maxMatches)];
  if (context > 0) rgArgs.push('-C', String(context));
  if (glob) rgArgs.push('--glob', glob);
  rgArgs.push(pattern, searchPath);

  try {
    const { stdout } = await execFileAsync('rg', rgArgs, {
      cwd: config.cwd,
      maxBuffer: 1024 * 1024,
      timeout: 30_000,
    });
    const out = stdout.trim();
    return out || '(no matches)';
  } catch (err) {
    const code = err && typeof err === 'object' && 'code' in err ? err.code : null;
    if (code === 1) return '(no matches)';
    // fallback grep
    const grepArgs = ['-rn', pattern, searchPath];
    try {
      const { stdout } = await execFileAsync('grep', grepArgs, {
        maxBuffer: 1024 * 1024,
        timeout: 30_000,
      });
      const lines = stdout.trim().split('\n').slice(0, maxMatches);
      return lines.join('\n') || '(no matches)';
    } catch (grepErr) {
      const gCode = grepErr && typeof grepErr === 'object' && 'code' in grepErr ? grepErr.code : null;
      if (gCode === 1) return '(no matches)';
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
): Promise<void> {
  if (depth > maxDepth) return;

  const entries = await readdir(dir, { withFileTypes: true });
  const sorted = entries.sort((a, b) => a.name.localeCompare(b.name));

  for (const entry of sorted) {
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
      );
    }
  }
}

async function listFiles(args: Record<string, unknown>, config: AgentConfig): Promise<string> {
  const rel = String(args.path ?? '.');
  const dir = resolveSafePath(config.cwd, rel);
  const maxDepth = args.max_depth === undefined ? 3 : Number(args.max_depth);
  const includeHidden = args.include_hidden === true;

  const lines: string[] = [`${rel}/`];
  await listTree(dir, '  ', 1, maxDepth, includeHidden, lines);
  return lines.join('\n');
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

async function unifiedDiff(before: string, after: string, label: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ma-diff-'));
  const beforePath = join(dir, 'before');
  const afterPath = join(dir, 'after');
  try {
    await writeFile(beforePath, before, 'utf8');
    await writeFile(afterPath, after, 'utf8');
    try {
      const { stdout } = await execFileAsync(
        'diff',
        ['-u', '--label', `${label} (before)`, '--label', `${label} (after)`, beforePath, afterPath],
        { maxBuffer: 1024 * 1024 },
      );
      return stdout.trim() || '(no differences)';
    } catch (err) {
      if (err && typeof err === 'object' && 'stdout' in err && typeof err.stdout === 'string') {
        const out = err.stdout.trim();
        return out || '(no differences)';
      }
      throw err;
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function diffFile(args: Record<string, unknown>, config: AgentConfig): Promise<string> {
  const path = String(args.path ?? '');
  const file = resolveSafePath(config.cwd, path);
  const after = await readFile(file, 'utf8');

  const before =
    resolveBeforeText(
      args.before_action_id ? String(args.before_action_id) : undefined,
      args.before_text !== undefined ? String(args.before_text) : undefined,
    ) ?? '';

  const diff = await unifiedDiff(before, after, path);
  const max = 8000;
  return diff.length > max ? `${diff.slice(0, max)}\n...(truncated)` : diff;
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