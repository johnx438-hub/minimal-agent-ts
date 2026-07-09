import { resolveShellCommandFromArgsJson } from '../../tools/tool-args.js';
import { pickCodeFence } from './markdown-fence.js';

/** Pure formatting helpers for run_shell tool display in pi TUI. */

export interface ShellDisplayParts {
  command: string;
  status: string;
  meta?: string;
  body: string;
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

export function buildShellDisplayParts(argsJson: string, output: string): ShellDisplayParts {
  const command = parseShellCommand(argsJson);
  const { meta, body } = splitShellOutput(output);
  const status = shellStatusFromOutput(output);
  return { command, status, meta, body };
}

export function formatShellSummaryLine(parts: ShellDisplayParts): string {
  const cmd = parts.command.length > 80 ? `${parts.command.slice(0, 80)}…` : parts.command;
  const metaNote = parts.meta ? `  ${parts.meta}` : '';
  return `← shell: ${parts.status}, $ ${cmd}${metaNote}`;
}

export function formatShellCallLine(command: string): string {
  const cmd = command.length > 100 ? `${command.slice(0, 100)}…` : command;
  return `→ shell: $ ${cmd}`;
}

export function formatShellLoaderMessage(command: string): string {
  const cmd = command.length > 72 ? `${command.slice(0, 72)}…` : command;
  return `$ ${cmd}`;
}

/** Markdown block: command header + fenced stdout/stderr body. */
export function formatShellResultMarkdown(parts: ShellDisplayParts): string {
  const cmd = parts.command.replace(/`/g, '\\`');
  const fence = pickCodeFence(parts.body);
  const lang = parts.body.includes('error:') ? 'text' : 'console';
  return `**$** \`${cmd || '(empty)'}\`\n\n${fence}${lang}\n${parts.body}\n${fence}`;
}