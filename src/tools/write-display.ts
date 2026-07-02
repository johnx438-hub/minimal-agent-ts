/** write_file result formatting — short agent summary + optional UI diff block. */

export const WRITE_DISPLAY_START = '\n[write_display]\n';
export const WRITE_DISPLAY_END = '\n[/write_display]';

const MAX_DIFF_LINES = 48;

export function splitWriteToolOutput(raw: string): { output: string; display?: string } {
  const start = raw.indexOf(WRITE_DISPLAY_START);
  if (start < 0) return { output: raw };
  const end = raw.indexOf(WRITE_DISPLAY_END, start + WRITE_DISPLAY_START.length);
  if (end < 0) return { output: raw };
  const output = raw.slice(0, start).trimEnd();
  const display = raw.slice(start + WRITE_DISPLAY_START.length, end);
  return { output, display };
}

export function buildWriteDiff(
  path: string,
  oldContent: string | null,
  newContent: string,
): string {
  if (oldContent === null) {
    const lines = ['--- /dev/null', `+++ ${path}`];
    for (const line of newContent.split('\n')) {
      lines.push(`+ ${line}`);
    }
    return truncateDiffLines(lines).join('\n');
  }

  const lines = [`--- ${path}`, `+++ ${path}`];
  for (const line of oldContent.split('\n')) {
    lines.push(`- ${line}`);
  }
  for (const line of newContent.split('\n')) {
    lines.push(`+ ${line}`);
  }
  return truncateDiffLines(lines).join('\n');
}

function truncateDiffLines(lines: string[]): string[] {
  if (lines.length <= MAX_DIFF_LINES) return lines;
  const head = lines.slice(0, MAX_DIFF_LINES - 1);
  head.push(`… (${lines.length - MAX_DIFF_LINES + 1} more diff lines omitted)`);
  return head;
}

export function formatWriteToolResult(
  path: string,
  byteSize: number,
  oldContent: string | null,
  newContent: string,
): string {
  const kind = oldContent === null ? 'new file' : 'overwrite';
  const summary = `ok: wrote ${byteSize} bytes to ${path} (${kind})`;
  const display = buildWriteDiff(path, oldContent, newContent);
  return `${summary}${WRITE_DISPLAY_START}${display}${WRITE_DISPLAY_END}`;
}

export function writeStatusFromOutput(output: string): 'ok' | 'error' {
  return output.trimStart().startsWith('ok:') ? 'ok' : 'error';
}

export function parseWriteKind(output: string): 'new file' | 'overwrite' | 'unknown' {
  if (output.includes('(new file)')) return 'new file';
  if (output.includes('(overwrite)')) return 'overwrite';
  return 'unknown';
}