import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { promisify } from 'node:util';

import type { AgentConfig, ToolDefinition } from './types.js';

const execFileAsync = promisify(execFile);

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read a text file. Use offset/limit for large files.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path (relative to cwd or absolute)' },
          offset: { type: 'integer', description: '1-based start line (optional)' },
          limit: { type: 'integer', description: 'Max lines to read (optional)' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Write or overwrite a text file.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path' },
          content: { type: 'string', description: 'Full file content' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_shell',
      description:
        'Run a shell command in the project directory. Disabled unless ALLOW_SHELL=1.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Shell command' },
        },
        required: ['command'],
      },
    },
  },
];

function resolveSafePath(cwd: string, input: string): string {
  const target = isAbsolute(input) ? input : resolve(cwd, input);
  const root = resolve(cwd);
  if (!target.startsWith(root)) {
    throw new Error(`path escapes working directory: ${input}`);
  }
  return target;
}

function sliceLines(text: string, offset?: number, limit?: number): string {
  const lines = text.split('\n');
  const start = Math.max(0, (offset ?? 1) - 1);
  const end = limit === undefined ? lines.length : start + limit;
  return lines.slice(start, end).join('\n');
}

export async function executeTool(
  name: string,
  argsJson: string,
  config: AgentConfig,
): Promise<string> {
  let args: Record<string, unknown>;
  try {
    args = JSON.parse(argsJson) as Record<string, unknown>;
  } catch {
    return `error: invalid JSON arguments: ${argsJson}`;
  }

  try {
    switch (name) {
      case 'read_file': {
        const path = String(args.path ?? '');
        const file = resolveSafePath(config.cwd, path);
        const raw = await readFile(file, 'utf8');
        const offset = args.offset === undefined ? undefined : Number(args.offset);
        const limit = args.limit === undefined ? undefined : Number(args.limit);
        const body = sliceLines(raw, offset, limit);
        return body.length > 8000 ? `${body.slice(0, 8000)}\n...(truncated)` : body;
      }

      case 'write_file': {
        const path = String(args.path ?? '');
        const content = String(args.content ?? '');
        const file = resolveSafePath(config.cwd, path);
        await writeFile(file, content, 'utf8');
        return `ok: wrote ${content.length} bytes to ${path}`;
      }

      case 'run_shell': {
        if (!config.allowShell) {
          return 'error: run_shell is disabled. Set ALLOW_SHELL=1 to enable.';
        }
        const command = String(args.command ?? '');
        const { stdout, stderr } = await execFileAsync('bash', ['-lc', command], {
          cwd: config.cwd,
          maxBuffer: 1024 * 1024,
          timeout: 30_000,
        });
        const out = [stdout, stderr].filter(Boolean).join('\n').trim();
        return out || '(no output)';
      }

      default:
        return `error: unknown tool ${name}`;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `error: ${msg}`;
  }
}