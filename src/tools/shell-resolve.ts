import { accessSync, constants, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { basename } from 'node:path';

export type ShellResolveSource =
  | 'minimal_shell'
  | 'shell_env'
  | 'platform_default'
  | 'path_probe';

export interface ShellInvocation {
  command: string;
  buildArgs: (userCommand: string) => string[];
  source: ShellResolveSource;
}

let cachedInvocation: ShellInvocation | null = null;

export function resetShellInvocationForTests(): void {
  cachedInvocation = null;
}

function isExecutableFile(path: string): boolean {
  if (!path.includes('/')) return false;
  if (!existsSync(path)) return false;
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return existsSync(path);
  }
}

function probeCommand(command: string, probeArgs: string[]): boolean {
  try {
    const result = spawnSync(command, probeArgs, {
      stdio: 'ignore',
      timeout: 3_000,
      windowsHide: true,
    });
    if (result.error) return false;
    return result.status === 0;
  } catch {
    return false;
  }
}

function shellName(command: string): string {
  return basename(command).replace(/\.exe$/i, '').toLowerCase();
}

function buildRunArgs(command: string, userCommand: string): string[] {
  const name = shellName(command);
  if (name === 'cmd') return ['/d', '/s', '/c', userCommand];
  if (name === 'powershell' || name === 'pwsh') {
    return ['-NoProfile', '-Command', userCommand];
  }
  if (name === 'fish') return ['-c', userCommand];
  return ['-lc', userCommand];
}

function probeArgs(command: string): string[] {
  const name = shellName(command);
  if (name === 'cmd') return ['/d', '/s', '/c', 'exit /b 0'];
  if (name === 'powershell' || name === 'pwsh') {
    return ['-NoProfile', '-Command', 'exit 0'];
  }
  return ['-c', 'exit 0'];
}

function wrapInvocation(
  command: string,
  source: ShellResolveSource,
): ShellInvocation {
  return {
    command,
    buildArgs: (userCommand) => buildRunArgs(command, userCommand),
    source,
  };
}

function resolveFromExplicit(command: string, source: ShellResolveSource): ShellInvocation | null {
  const trimmed = command.trim();
  if (!trimmed) return null;

  if (trimmed.includes('/') || trimmed.includes('\\')) {
    if (!isExecutableFile(trimmed) && !existsSync(trimmed)) return null;
  }

  if (!probeCommand(trimmed, probeArgs(trimmed))) return null;
  return wrapInvocation(trimmed, source);
}

function resolveWindowsShell(): ShellInvocation {
  for (const candidate of ['bash', 'sh', 'zsh']) {
    const resolved = resolveFromExplicit(candidate, 'path_probe');
    if (resolved) return resolved;
  }

  const comspec = process.env.ComSpec?.trim() || 'cmd.exe';
  return wrapInvocation(comspec, 'platform_default');
}

function resolvePosixShell(): ShellInvocation {
  const candidates = [
    process.env.SHELL?.trim(),
    '/bin/bash',
    '/usr/bin/bash',
    '/bin/sh',
    '/usr/bin/sh',
    'bash',
    'sh',
    'zsh',
  ].filter((value): value is string => Boolean(value));

  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (seen.has(candidate)) continue;
    seen.add(candidate);

    const source: ShellResolveSource =
      candidate === process.env.SHELL?.trim() ? 'shell_env' : 'path_probe';
    const resolved = resolveFromExplicit(candidate, source);
    if (resolved) return resolved;
  }

  return wrapInvocation('sh', 'platform_default');
}

/** Resolve a shell executable and argument builder for run_shell. Cached per process. */
export function resolveShellInvocation(force = false): ShellInvocation {
  if (!force && cachedInvocation) return cachedInvocation;

  const override = process.env.MINIMAL_SHELL?.trim();
  if (override) {
    const resolved = resolveFromExplicit(override, 'minimal_shell');
    if (resolved) {
      cachedInvocation = resolved;
      return resolved;
    }
  }

  cachedInvocation =
    process.platform === 'win32' ? resolveWindowsShell() : resolvePosixShell();
  return cachedInvocation;
}