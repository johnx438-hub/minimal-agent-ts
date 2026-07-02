import { pickCodeFence } from './markdown-fence.js';

export type EditMode = 'search_replace' | 'line_range' | 'unknown';

export interface ParsedEditArgs {
  path: string;
  mode: EditMode;
  oldString?: string;
  newString?: string;
  replaceAll?: boolean;
  startLine?: number;
  endLine?: number;
  newContent?: string;
}

export interface EditDisplayParts {
  path: string;
  mode: EditMode;
  status: 'ok' | 'error';
  replaceAll?: boolean;
  lineRange?: { start: number; end: number };
  diffText: string;
  errorBody?: string;
  fileHash?: string;
}

const MAX_DIFF_LINES = 48;

export function parseEditArgs(argsJson: string): ParsedEditArgs {
  try {
    const args = JSON.parse(argsJson) as Record<string, unknown>;
    const path = String(args.path ?? '').trim();
    const hasSearch = args.old_string !== undefined;
    const hasLine = args.start_line !== undefined;

    if (hasSearch) {
      return {
        path,
        mode: 'search_replace',
        oldString: String(args.old_string ?? ''),
        newString: String(args.new_string ?? ''),
        replaceAll: args.replace_all === true,
      };
    }

    if (hasLine) {
      const startLine = Number(args.start_line);
      const endLine = Number(args.end_line ?? args.start_line);
      return {
        path,
        mode: 'line_range',
        startLine: Number.isFinite(startLine) ? startLine : undefined,
        endLine: Number.isFinite(endLine) ? endLine : undefined,
        newContent: String(args.new_content ?? ''),
      };
    }

    return { path, mode: 'unknown' };
  } catch {
    return { path: '', mode: 'unknown' };
  }
}

export function editStatusFromOutput(output: string): 'ok' | 'error' {
  return output.trimStart().startsWith('ok:') ? 'ok' : 'error';
}

export function parseEditOkOutput(output: string): { fileHash?: string } {
  const hashMatch = output.match(/file_hash=([a-f0-9]+)/);
  return { fileHash: hashMatch?.[1] };
}

export function buildEditDiffText(parsed: ParsedEditArgs): string {
  if (parsed.mode === 'search_replace') {
    const note = parsed.replaceAll ? ' (replace_all)' : '';
    const header = `--- ${parsed.path}${note}`;
    const body = buildReplacementDiff(parsed.oldString ?? '', parsed.newString ?? '');
    return `${header}\n+++ ${parsed.path}\n${body}`;
  }

  if (parsed.mode === 'line_range' && parsed.startLine !== undefined) {
    const end = parsed.endLine ?? parsed.startLine;
    const removed = Math.max(1, end - parsed.startLine + 1);
    const lines = [
      `@@ ${parsed.path}:${parsed.startLine}-${end} @@`,
      `- <${removed} line(s) removed>`,
    ];
    for (const line of (parsed.newContent ?? '').split('\n')) {
      lines.push(`+ ${line}`);
    }
    return lines.join('\n');
  }

  return '(no diff — args not recognized)';
}

function buildReplacementDiff(oldString: string, newString: string): string {
  const oldLines = oldString.split('\n');
  const newLines = newString.split('\n');
  const out: string[] = [];
  for (const line of oldLines) out.push(`- ${line}`);
  for (const line of newLines) out.push(`+ ${line}`);
  return truncateDiffLines(out).join('\n');
}

function truncateDiffLines(lines: string[]): string[] {
  if (lines.length <= MAX_DIFF_LINES) return lines;
  const head = lines.slice(0, MAX_DIFF_LINES - 1);
  head.push(`… (${lines.length - MAX_DIFF_LINES + 1} more diff lines omitted)`);
  return head;
}

export function buildEditDisplayParts(
  argsJson: string,
  output: string,
  display?: string,
): EditDisplayParts {
  const parsed = parseEditArgs(argsJson);
  const status = editStatusFromOutput(output);
  const { fileHash } = parseEditOkOutput(output);

  if (status === 'error') {
    return {
      path: parsed.path || '?',
      mode: parsed.mode,
      status,
      diffText: '',
      errorBody: output.trim(),
      replaceAll: parsed.replaceAll,
      lineRange:
        parsed.startLine !== undefined
          ? { start: parsed.startLine, end: parsed.endLine ?? parsed.startLine }
          : undefined,
    };
  }

  const diffText = display?.trim() || buildEditDiffText(parsed);

  return {
    path: parsed.path,
    mode: parsed.mode,
    status,
    replaceAll: parsed.replaceAll,
    lineRange:
      parsed.startLine !== undefined
        ? { start: parsed.startLine, end: parsed.endLine ?? parsed.startLine }
        : undefined,
    diffText,
    fileHash,
  };
}

export function formatEditModeLabel(parts: EditDisplayParts): string {
  if (parts.mode === 'search_replace') {
    return parts.replaceAll ? 'search_replace, replace_all' : 'search_replace';
  }
  if (parts.mode === 'line_range' && parts.lineRange) {
    return `lines ${parts.lineRange.start}-${parts.lineRange.end}`;
  }
  return parts.mode;
}

export function formatEditCallLine(parts: Pick<EditDisplayParts, 'path' | 'mode'> & {
  replaceAll?: boolean;
  lineRange?: { start: number; end: number };
}): string {
  const path = parts.path.length > 80 ? `${parts.path.slice(0, 80)}…` : parts.path;
  const mode = formatEditModeLabel(parts as EditDisplayParts);
  return `→ edit: ${path} (${mode})`;
}

export function formatEditCallLineFromArgs(parsed: ParsedEditArgs): string {
  return formatEditCallLine({
    path: parsed.path || '?',
    mode: parsed.mode,
    replaceAll: parsed.replaceAll,
    lineRange:
      parsed.startLine !== undefined
        ? { start: parsed.startLine, end: parsed.endLine ?? parsed.startLine }
        : undefined,
  });
}

export function formatEditSummaryLine(parts: EditDisplayParts): string {
  const path = parts.path.length > 72 ? `${parts.path.slice(0, 72)}…` : parts.path;
  if (parts.status === 'error') {
    const first = (parts.errorBody ?? 'error').split('\n')[0] ?? 'error';
    const clipped = first.length > 100 ? `${first.slice(0, 100)}…` : first;
    return `← edit: error, ${path} — ${clipped}`;
  }
  const hash = parts.fileHash ? `  hash=${parts.fileHash.slice(0, 8)}` : '';
  return `← edit: ok, ${path} (${formatEditModeLabel(parts)})${hash}`;
}

export function formatEditResultMarkdown(parts: EditDisplayParts): string {
  const path = parts.path.replace(/`/g, '\\`');
  const mode = formatEditModeLabel(parts);

  if (parts.status === 'error') {
    const body = parts.errorBody ?? 'error';
    const fence = pickCodeFence(body);
    return `**edit** \`${path}\` (${mode})\n\n${fence}text\n${body}\n${fence}`;
  }

  const fence = pickCodeFence(parts.diffText);
  return `**edit** \`${path}\` (${mode})\n\n${fence}diff\n${parts.diffText}\n${fence}`;
}