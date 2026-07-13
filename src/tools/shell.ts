import { spawn } from 'node:child_process';

import { sleep } from '../llm-retry.js';
import { isCapabilityEnabled } from '../permission-gate.js';
import { evaluateSpawnShellPolicy } from '../spawn/shell-policy.js';
import type { AgentConfig, ToolDefinition } from '../types.js';
import { resolveReadablePath } from './path-utils.js';
import { resolveShellInvocation } from './shell-resolve.js';
import { decodeShellCommand } from './tool-args.js';

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_POLL_INTERVAL_MS = 2_000;
const DEFAULT_EXTEND_BY_MS = 30_000;
const DEFAULT_MAX_TIMEOUT_MS = 300_000;
const MAX_BUFFER_BYTES = 1024 * 1024;

function clampInt(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  const n = value === undefined ? fallback : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

function formatOutput(stdout: string, stderr: string): string {
  const out = [stdout, stderr].filter(Boolean).join('\n').trim();
  return out || '(no output)';
}

function formatShellError(prefix: string, stdout: string, stderr: string): string {
  const body = formatOutput(stdout, stderr);
  return body === '(no output)' ? `error: ${prefix}` : `error: ${prefix}\n${body}`;
}

export interface ShellRunOptions {
  cwd: string;
  command: string;
  delayMs: number;
  timeoutMs: number;
  pollIntervalMs: number;
  autoExtend: boolean;
  extendByMs: number;
  maxTimeoutMs: number;
  abortSignal?: AbortSignal;
}

function parseShellArgs(args: Record<string, unknown>): ShellRunOptions | string {
  const decoded = decodeShellCommand(args);
  if (!decoded.ok) return decoded.error;
  const command = decoded.command;

  const timeoutMs = clampInt(args.timeout_ms, DEFAULT_TIMEOUT_MS, 1_000, 600_000);
  let maxTimeoutMs = clampInt(args.max_timeout_ms, DEFAULT_MAX_TIMEOUT_MS, timeoutMs, 600_000);
  if (maxTimeoutMs < timeoutMs) maxTimeoutMs = timeoutMs;

  return {
    command,
    cwd: '', // filled by caller
    delayMs: clampInt(args.delay_ms, 0, 0, 60_000),
    timeoutMs,
    pollIntervalMs: clampInt(args.poll_interval_ms, DEFAULT_POLL_INTERVAL_MS, 500, 10_000),
    autoExtend: args.auto_extend === true,
    extendByMs: clampInt(args.extend_by_ms, DEFAULT_EXTEND_BY_MS, 5_000, 120_000),
    maxTimeoutMs,
  };
}

export async function runShellCommand(opts: ShellRunOptions): Promise<string> {
  if (opts.delayMs > 0) {
    await sleep(opts.delayMs, opts.abortSignal);
  }

  const startedAt = Date.now();

  return new Promise((resolve) => {
    const shell = resolveShellInvocation();
    const child = spawn(shell.command, shell.buildArgs(opts.command), {
      cwd: opts.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let bytes = 0;
    let deadline = Date.now() + opts.timeoutMs;
    let budgetMs = opts.timeoutMs;
    const extensions: string[] = [];
    let timedOut = false;
    let bufferExceeded = false;

    const append = (chunk: Buffer, target: 'stdout' | 'stderr'): void => {
      const text = chunk.toString();
      bytes += text.length;
      if (bytes > MAX_BUFFER_BYTES) {
        bufferExceeded = true;
        child.kill('SIGTERM');
        return;
      }
      if (target === 'stdout') stdout += text;
      else stderr += text;
    };

    child.stdout?.on('data', (chunk: Buffer) => append(chunk, 'stdout'));
    child.stderr?.on('data', (chunk: Buffer) => append(chunk, 'stderr'));

    const onAbort = (): void => {
      if (child.exitCode !== null) return;
      child.kill('SIGTERM');
      setTimeout(() => {
        if (child.exitCode === null) child.kill('SIGKILL');
      }, 1_000);
    };
    opts.abortSignal?.addEventListener('abort', onAbort, { once: true });

    const poll = setInterval(() => {
      if (opts.abortSignal?.aborted) {
        onAbort();
      }
      if (child.exitCode !== null) return;

      const now = Date.now();
      if (now < deadline) return;

      if (opts.autoExtend && budgetMs < opts.maxTimeoutMs) {
        const room = opts.maxTimeoutMs - budgetMs;
        const extend = Math.min(opts.extendByMs, room);
        if (extend > 0) {
          budgetMs += extend;
          deadline = now + extend;
          extensions.push(`+${Math.round(extend / 1000)}s`);
          return;
        }
      }

      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => {
        if (child.exitCode === null) child.kill('SIGKILL');
      }, 1_000);
    }, opts.pollIntervalMs);

    const finish = (code: number | null, signal: NodeJS.Signals | null): void => {
      clearInterval(poll);
      opts.abortSignal?.removeEventListener('abort', onAbort);
      const elapsedSec = Math.round((Date.now() - startedAt) / 1000);
      let meta = '';

      if (extensions.length > 0) {
        meta = `[shell: auto-extended ${extensions.join(', ')}, elapsed=${elapsedSec}s, budget=${Math.round(budgetMs / 1000)}s]\n`;
      } else if (opts.delayMs > 0 || opts.timeoutMs !== DEFAULT_TIMEOUT_MS || opts.autoExtend) {
        meta = `[shell: elapsed=${elapsedSec}s, timeout_ms=${opts.timeoutMs}${opts.autoExtend ? `, max_timeout_ms=${opts.maxTimeoutMs}` : ''}]\n`;
      }

      if (bufferExceeded) {
        resolve(
          formatShellError(
            `output exceeded ${MAX_BUFFER_BYTES} bytes`,
            stdout,
            stderr,
          ),
        );
        return;
      }

      if (opts.abortSignal?.aborted) {
        resolve(
          meta +
            formatShellError('command aborted', stdout, stderr),
        );
        return;
      }

      if (timedOut || signal === 'SIGTERM' || signal === 'SIGKILL') {
        const prefix = timedOut
          ? `command timed out after ${Math.round(budgetMs / 1000)}s`
          : `command killed (${signal ?? 'signal'})`;
        resolve(meta + formatShellError(prefix, stdout, stderr));
        return;
      }

      if (code !== 0 && code !== null) {
        resolve(meta + formatShellError(`exit ${code}`, stdout, stderr));
        return;
      }

      resolve(meta + formatOutput(stdout, stderr));
    };

    child.on('error', (err) => {
      clearInterval(poll);
      resolve(formatShellError(err.message, stdout, stderr));
    });

    child.on('close', (code, signal) => finish(code, signal));
  });
}

export const SHELL_DEFINITIONS: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'run_shell',
      description:
        'Run a shell command (auto-detects SHELL / bash / sh; override with MINIMAL_SHELL). Disabled unless ALLOW_SHELL=1 or --allow-shell. For commands with quotes/backslashes, prefer command_b64 (UTF-8 base64). Supports delay, custom timeout, and poll-based auto-extend for long commands.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Shell command (plain text)' },
          command_b64: {
            type: 'string',
            description:
              'Base64-encoded UTF-8 shell command. Prefer when the command contains quotes, backslashes, or complex escaping.',
          },
          working_dir: {
            type: 'string',
            description: 'Optional subdirectory under project cwd (default: project root)',
          },
          delay_ms: {
            type: 'integer',
            description: 'Wait this many ms before starting the command (0–60000)',
          },
          timeout_ms: {
            type: 'integer',
            description: 'Initial timeout in ms (default 30000, max 600000)',
          },
          poll_interval_ms: {
            type: 'integer',
            description: 'When auto_extend=true, poll every N ms (default 2000)',
          },
          auto_extend: {
            type: 'boolean',
            description:
              'If true, extend timeout in extend_by_ms chunks while process still runs, up to max_timeout_ms',
          },
          extend_by_ms: {
            type: 'integer',
            description: 'Each auto-extension adds this many ms (default 30000)',
          },
          max_timeout_ms: {
            type: 'integer',
            description: 'Hard cap when auto_extend=true (default 300000)',
          },
        },
        required: [],
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

  if (!isCapabilityEnabled(config, 'shell')) {
    return 'error: run_shell is disabled. Use /shell on, /approve always shell, or --allow-shell.';
  }

  const parsed = parseShellArgs(args);
  if (typeof parsed === 'string') return parsed;

  let workDir = config.cwd;
  if (args.working_dir !== undefined) {
    const dir = String(args.working_dir).trim();
    if (!dir) {
      return 'error: working_dir must be a non-empty path';
    }
    try {
      workDir = await resolveReadablePath(config, dir, `run_shell working_dir: ${dir}`);
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        return '[aborted]';
      }
      const msg = err instanceof Error ? err.message : String(err);
      return `error: ${msg}`;
    }
  }

  // C5: enforce spawn shell policy only for nested agents (depth > 0).
  if ((config.spawnDepth ?? 0) > 0) {
    const verdict = evaluateSpawnShellPolicy(parsed.command, config.spawnShellPolicy, {
      cwd: workDir,
      requestedTimeoutMs: args.timeout_ms !== undefined ? parsed.timeoutMs : undefined,
      requestedMaxTimeoutMs:
        args.max_timeout_ms !== undefined ? parsed.maxTimeoutMs : undefined,
    });
    if (!verdict.ok) {
      return `error: ${verdict.reason ?? 'run_shell blocked by spawn_shell_policy'}`;
    }
    if (verdict.timeout_ms !== undefined) {
      parsed.timeoutMs = clampInt(verdict.timeout_ms, DEFAULT_TIMEOUT_MS, 1_000, 600_000);
    }
    if (verdict.max_timeout_ms !== undefined) {
      parsed.maxTimeoutMs = clampInt(
        verdict.max_timeout_ms,
        DEFAULT_MAX_TIMEOUT_MS,
        parsed.timeoutMs,
        600_000,
      );
    }
    if (parsed.maxTimeoutMs < parsed.timeoutMs) {
      parsed.maxTimeoutMs = parsed.timeoutMs;
    }
  }

  return runShellCommand({ ...parsed, cwd: workDir, abortSignal: config.abortSignal });
}