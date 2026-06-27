import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type { AgentConfig, ToolDefinition } from '../types.js';
import { resolveSafePath } from './path-utils.js';

const execFileAsync = promisify(execFile);

const SHELL_TIMEOUT_MS = 30_000;

type ExecFailure = NodeJS.ErrnoException & {
  stdout?: string | Buffer;
  stderr?: string | Buffer;
  killed?: boolean;
  signal?: string;
};

function formatOutput(stdout?: string | Buffer, stderr?: string | Buffer): string {
  const out = [stdout, stderr]
    .map((chunk) => (chunk === undefined ? '' : String(chunk)))
    .filter(Boolean)
    .join('\n')
    .trim();
  return out || '(no output)';
}

function formatShellError(prefix: string, stdout?: string | Buffer, stderr?: string | Buffer): string {
  const body = formatOutput(stdout, stderr);
  return body === '(no output)' ? `error: ${prefix}` : `error: ${prefix}\n${body}`;
}

export const SHELL_DEFINITIONS: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'run_shell',
      description:
        'Run a bash command. Disabled unless ALLOW_SHELL=1 or --allow-shell. Optional working_dir (relative to project cwd).',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Shell command' },
          working_dir: {
            type: 'string',
            description: 'Optional subdirectory under project cwd (default: project root)',
          },
        },
        required: ['command'],
      },
    },
  },
];

export async function runShellTool(
  name: string,
  args: Record<string, unknown>,
  config: AgentConfig,
): Promise<string | null> {
  if (name !== 'run_shell') return null;

  if (!config.allowShell) {
    return 'error: run_shell is disabled. Use --allow-shell or set ALLOW_SHELL=1.';
  }

  const command = String(args.command ?? '').trim();
  if (!command) {
    return 'error: command is required';
  }

  let workDir = config.cwd;
  if (args.working_dir !== undefined) {
    const dir = String(args.working_dir).trim();
    if (!dir) {
      return 'error: working_dir must be a non-empty path';
    }
    try {
      workDir = resolveSafePath(config.cwd, dir);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return `error: ${msg}`;
    }
  }

  try {
    const { stdout, stderr } = await execFileAsync('bash', ['-lc', command], {
      cwd: workDir,
      maxBuffer: 1024 * 1024,
      timeout: SHELL_TIMEOUT_MS,
    });
    return formatOutput(stdout, stderr);
  } catch (err) {
    const failure = err as ExecFailure;
    const stdout = failure.stdout;
    const stderr = failure.stderr;

    if (failure.killed && failure.signal) {
      return formatShellError(`command timed out after ${SHELL_TIMEOUT_MS / 1000}s`, stdout, stderr);
    }

    if (typeof failure.code === 'number') {
      return formatShellError(`exit ${failure.code}`, stdout, stderr);
    }

    const msg = failure.message || String(err);
    return formatShellError(msg, stdout, stderr);
  }
}