/**
 * Rebuild write/edit UI display blocks for Web/history when cold storage only
 * kept the agent-facing "ok:" summary (display was stripped at persist time).
 */

import { formatEditToolResult } from './edit-display.js';
import { formatWriteToolResult } from './write-display.js';

const MAX_DISPLAY_CHARS = 16_000;

function clipDisplayBody(text: string): string {
  if (text.length <= MAX_DISPLAY_CHARS) return text;
  return `${text.slice(0, MAX_DISPLAY_CHARS)}\n… [display truncated]`;
}

function hasUiDisplay(content: string): boolean {
  return (
    content.includes('[write_display]') || content.includes('[edit_display]')
  );
}

/**
 * If content is already rich, return as-is. Else rebuild from args_json for
 * write_file / edit_file. Caps display size for chat history.
 */
export function enrichToolContentForUi(input: {
  toolName?: string;
  content: string;
  argsJson?: string;
  resultText?: string;
}): string {
  const raw = input.content ?? '';
  if (hasUiDisplay(raw)) return raw;

  const name = (input.toolName ?? '').trim();
  const argsJson = input.argsJson?.trim();
  if (!argsJson) return raw;

  try {
    if (name === 'write_file') {
      const args = JSON.parse(argsJson) as {
        path?: string;
        content?: string;
      };
      const path = String(args.path ?? '').trim() || 'file';
      const body = typeof args.content === 'string' ? args.content : '';
      if (!body) return raw;
      const byteSize = Buffer.byteLength(body, 'utf8');
      // Treat as new-file style add-diff for UI (args don't keep prior content)
      const full = formatWriteToolResult(path, byteSize, null, body);
      return clipDisplayInResult(full);
    }

    if (name === 'edit_file') {
      const args = JSON.parse(argsJson) as {
        path?: string;
        old_string?: string;
        new_string?: string;
      };
      const path = String(args.path ?? '').trim() || 'file';
      const oldS = typeof args.old_string === 'string' ? args.old_string : '';
      const newS = typeof args.new_string === 'string' ? args.new_string : '';
      if (!oldS && !newS) return raw;
      const summary =
        (input.resultText ?? raw).trim() ||
        `ok: edited ${path}`;
      // Prefer structured formatEditToolResult (includes hash placeholder)
      const full = formatEditToolResult(
        path,
        Buffer.byteLength(newS || oldS, 'utf8'),
        'history',
        oldS,
        newS,
        'search_replace',
      );
      // Keep original ok: line if present (file_hash etc.)
      if (summary.startsWith('ok:')) {
        const start = full.indexOf('\n[edit_display]');
        if (start >= 0) {
          return clipDisplayInResult(summary + full.slice(start));
        }
      }
      return clipDisplayInResult(full);
    }
  } catch {
    return raw;
  }

  return raw;
}

function clipDisplayInResult(full: string): string {
  const markers: Array<[string, string]> = [
    ['\n[write_display]\n', '\n[/write_display]'],
    ['\n[edit_display]\n', '\n[/edit_display]'],
  ];
  for (const [start, end] of markers) {
    const s = full.indexOf(start);
    if (s < 0) continue;
    const e = full.indexOf(end, s + start.length);
    if (e < 0) continue;
    const head = full.slice(0, s + start.length);
    const body = full.slice(s + start.length, e);
    const tail = full.slice(e);
    return head + clipDisplayBody(body) + tail;
  }
  return full.length > MAX_DISPLAY_CHARS
    ? `${full.slice(0, MAX_DISPLAY_CHARS)}…`
    : full;
}
