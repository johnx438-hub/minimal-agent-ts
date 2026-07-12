import { resolveShellCommandFromArgsJson } from '../../tools/tool-args.js';
import { pickCodeFence } from './markdown-fence.js';

/** Pure formatting helpers for run_shell tool display in pi TUI. */

/** Default max lines for failed shell bodies (SPEC_TUI_POLISH TUI-D). */
export const DEFAULT_SHELL_FAIL_MAX_LINES = 40;

export interface ShellDisplayParts {
  command: string;
  status: string;
  meta?: string;
  body: string;
  /** Set when body was truncated for display. */
  truncatedLines?: number;
}

export function parseShellCommand(argsJson: string): string {
  return resolveShellCommandFromArgsJson(argsJson);
}

export function splitShellOutput(output: string): { meta?: string; body: string } {
  const flat = output.replace(/\r\n/g, '\n');
  const metaMatch = flat.match(/^\[shell:[^\]]+\]\n?/);
  if (!metaMatch) {
    return { body: flat.trim() };
  }
  const meta = metaMatch[0].trimEnd();
  const body = flat.slice(metaMatch[0].length).trim();
  return { meta, body: body || '(no output)' };
}

export function shellStatusFromOutput(output: string): string {
  const errMatch = output.match(/^error: exit (\d+)/m);
  const timeoutMatch = output.match(/^error: command timed out/m);
  const abortedMatch = output.match(/^error: command aborted/m);
  if (abortedMatch) return 'aborted';
  if (timeoutMatch) return 'timeout';
  if (errMatch) return `exit ${errMatch[1]}`;
  if (output.startsWith('error:')) return 'error';
  return 'ok';
}

/**
 * Strip a repeated cwd absolute-path prefix from a shell command for display.
 * e.g. `cd /proj && cat /proj/a.ts` → `cd . && cat a.ts` when cwd is /proj.
 */
export function compressCommandCwd(command: string, cwd?: string): string {
  if (!cwd || !command.includes(cwd)) return command;
  const normalized = cwd.replace(/\/+$/, '');
  if (normalized.length < 2) return command;
  // Prefer longer matches first: cwd/ then cwd
  let out = command.split(normalized + '/').join('');
  out = out.split(normalized).join('.');
  return out;
}

export function truncateShellBody(
  body: string,
  maxLines: number = DEFAULT_SHELL_FAIL_MAX_LINES,
): { body: string; truncatedLines: number } {
  const lines = body.replace(/\r\n/g, '\n').split('\n');
  if (lines.length <= maxLines) {
    return { body, truncatedLines: 0 };
  }
  const kept = lines.slice(0, maxLines);
  const truncatedLines = lines.length - maxLines;
  kept.push(`… +${truncatedLines} lines`);
  return { body: kept.join('\n'), truncatedLines };
}

export function buildShellDisplayParts(
  argsJson: string,
  output: string,
  opts?: { cwd?: string; maxFailLines?: number; verboseTools?: boolean },
): ShellDisplayParts {
  const rawCommand = parseShellCommand(argsJson);
  const command = compressCommandCwd(rawCommand, opts?.cwd);
  const { meta, body: rawBody } = splitShellOutput(output);
  const status = shellStatusFromOutput(output);

  let body = rawBody;
  let truncatedLines = 0;
  if (status !== 'ok' && !opts?.verboseTools) {
    const capped = truncateShellBody(rawBody, opts?.maxFailLines ?? DEFAULT_SHELL_FAIL_MAX_LINES);
    body = capped.body;
    truncatedLines = capped.truncatedLines;
  }

  return {
    command,
    status,
    meta,
    body,
    truncatedLines: truncatedLines > 0 ? truncatedLines : undefined,
  };
}

export function formatShellSummaryLine(parts: ShellDisplayParts): string {
  const cmd = parts.command.length > 80 ? `${parts.command.slice(0, 80)}…` : parts.command;
  const metaNote = parts.meta ? `  ${parts.meta}` : '';
  return `← shell: ${parts.status}, $ ${cmd}${metaNote}`;
}

export function formatShellCallLine(command: string, cwd?: string): string {
  const compressed = compressCommandCwd(command, cwd);
  const cmd = compressed.length > 100 ? `${compressed.slice(0, 100)}…` : compressed;
  return `→ shell: $ ${cmd}`;
}

export function formatShellLoaderMessage(command: string, cwd?: string): string {
  const compressed = compressCommandCwd(command, cwd);
  const cmd = compressed.length > 72 ? `${compressed.slice(0, 72)}…` : compressed;
  return `$ ${cmd}`;
}

/** Markdown block: command header + fenced stdout/stderr body. */
export function formatShellResultMarkdown(parts: ShellDisplayParts): string {
  const cmd = parts.command.replace(/`/g, '\\`');
  const fence = pickCodeFence(parts.body);
  const lang = parts.body.includes('error:') || parts.status !== 'ok' ? 'text' : 'console';
  return `**$** \`${cmd || '(empty)'}\`\n\n${fence}${lang}\n${parts.body}\n${fence}`;
}