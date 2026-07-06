import { editStatusFromOutput } from './edit-display.js';
import { shellStatusFromOutput } from './shell-display.js';
import { writeStatusFromOutput } from '../../tools/write-display.js';

export function isToolFailure(name: string, output: string): boolean {
  const trimmed = output.trim();
  if (trimmed.startsWith('[aborted]')) return true;

  if (name === 'write_file') return writeStatusFromOutput(output) === 'error';
  if (name === 'edit_file') return editStatusFromOutput(output) === 'error';
  if (name === 'run_shell') return shellStatusFromOutput(output) !== 'ok';

  return trimmed.startsWith('error:');
}

export function formatTurnToolFlushLine(okCount: number): string | null {
  if (okCount <= 0) return null;
  const noun = okCount === 1 ? 'tool call' : 'tool calls';
  return `✓ ${okCount} ${noun} finished`;
}

export function formatGenericToolFailureLine(
  name: string,
  output: string,
  preview?: string,
): string {
  const source = (preview ?? output).trim();
  const shown = source.length > 400 ? `${source.slice(0, 400)}…` : source;
  return `✗ ${name}: ${shown.replace(/\n/g, '\\n')}`;
}