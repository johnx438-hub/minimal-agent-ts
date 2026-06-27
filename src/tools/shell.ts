import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type { AgentConfig, ToolDefinition } from '../types.js';

const execFileAsync = promisify(execFile);

export const SHELL_DEFINITIONS: ToolDefinition[] = [
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

export async function runShellTool(
  name: string,
  args: Record<string, unknown>,
  config: AgentConfig,
): Promise<string | null> {
  if (name !== 'run_shell') return null;

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