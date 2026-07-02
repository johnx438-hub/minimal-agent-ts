/** edit_file result formatting — short agent summary + optional UI diff block. */

import { buildUnifiedLineDiff } from './line-diff.js';

export const EDIT_DISPLAY_START = '\n[edit_display]\n';
export const EDIT_DISPLAY_END = '\n[/edit_display]';

export function splitEditToolOutput(raw: string): { output: string; display?: string } {
  const start = raw.indexOf(EDIT_DISPLAY_START);
  if (start < 0) return { output: raw };
  const end = raw.indexOf(EDIT_DISPLAY_END, start + EDIT_DISPLAY_START.length);
  if (end < 0) return { output: raw };
  const output = raw.slice(0, start).trimEnd();
  const display = raw.slice(start + EDIT_DISPLAY_START.length, end);
  return { output, display };
}

export function formatEditToolResult(
  path: string,
  byteSize: number,
  fileHash: string,
  oldSnippet: string,
  newSnippet: string,
  mode: 'search_replace' | 'line_range',
): string {
  const summary = `ok: edited ${path} (${byteSize} bytes) file_hash=${fileHash}`;
  const display = buildUnifiedLineDiff({
    path,
    oldText: oldSnippet,
    newText: newSnippet,
    oldLabel: `a/${path} (${mode})`,
    newLabel: `b/${path} (${mode})`,
  });
  return `${summary}${EDIT_DISPLAY_START}${display}${EDIT_DISPLAY_END}`;
}